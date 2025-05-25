const path = require("path");
const https = require("https");
const axios = require('axios');

const fastify = require("fastify")({
  logger: false,
});

fastify.register(require("@fastify/static"), {
  root: path.join(__dirname, "public"),
  prefix: "/",
});

fastify.register(require("@fastify/view"), {
  engine: {
    handlebars: require("handlebars"),
  },
});

// Our main GET home page route, pulls from src/pages/index.hbs
fastify.get("/", function (request, reply) {

  let dataTimestamp = "never";

  let params = {
    greeting: "Strava Data",
    dataTimestamp: dataTimestamp,
    oauthURL: "\'"+process.env.OAUTH_URL+"\'",
  };

  if (request.headers.cookie) {
    //console.log("Cookie: " + request.headers.cookie);
    dataTimestamp = request.headers.cookie.substr(request.headers.cookie.indexOf("=") + 1);
    return reply.view("/src/pages/index.hbs", params);
  } else {
    return reply.view("/src/pages/get-started.hbs", params);
  }
});

// Handle Strava OAuth token request success callback
fastify.get("/exchange_token", function (request, reply) {
  let dataTimestamp = "never";
  if (request.headers.cookie) {
    dataTimestamp = request.headers.cookie.substr(
      request.headers.cookie.indexOf("=") + 1
    );
  }

  let params = {
    greeting: "Strava Data",
    authorized: true,
    dataTimestamp: dataTimestamp,
  };

  // Exchange code for token
  // http://localhost/exchange_token?state=&code=3aea65e9b592ff98c58351dc547f46549a865a6a&scope=read

  /*
  curl -X POST https://www.strava.com/api/v3/oauth/token \
  -d client_id=ReplaceWithClientID \
  -d client_secret=ReplaceWithClientSecret \
  -d code=ReplaceWithCode \
  -d grant_type=authorization_code
  */

  const postData = JSON.stringify({
    client_id: 55374,
    client_secret: process.env.CLIENT_SECRET,
    code: request.query.code,
    grant_type: "authorization_code",
  });

  // Options for the HTTPS request
  const options = {
    hostname: "www.strava.com",
    port: 443,
    path: "/api/v3/oauth/token",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(postData),
    },
  };

  // Create the HTTPS request
  const req = https.request(options, (res) => {
    let responseData = "";

    res.on("data", (chunk) => {
      responseData += chunk;
    });

    res.on("end", () => {
      //console.log("Response:", responseData);
      let data = JSON.parse(responseData);
      //console.log("Data:", data);
      let accessToken = data.access_token;
      params.athleteName = data.athlete.firstname + " " + data.athlete.lastname;
      params.athleteCity = data.athlete.city;
      params.athletePic = data.athlete.profile;

      //let pageNum = 1;

      //getActivities(accessToken, params, pageNum);

      // Pack some data into the cookie...
      reply.header(
        "set-cookie", "access_token=" + data.access_token
      );
      reply.header(
        "set-cookie", "expires_at=" + data.expires_at
      );
      reply.header(
        "set-cookie", "refresh_token=" + data.refresh_token
      );
      reply.header(
        "set-cookie", "athlete_name=" + data.athlete.firstname + " " + data.athlete.lastname
      );
      reply.header(
        "set-cookie", "athlete_city=" + data.athlete.city
      );
      reply.header(
        "set-cookie", "athlete_pic_url=" + data.athlete.profile
      );

      reply.redirect('/');
      return reply.view("/src/pages/index.hbs", params);
    });
  });

  // Handle errors
  req.on("error", (error) => {
    console.error("Error:", error.message);
  });

  // Send the POST data
  req.write(postData);
  req.end();

  //return reply.view("/src/pages/index.hbs", params);
});

/* 
curl -X POST https://www.strava.com/api/v3/oauth/token \
  -d client_id=ReplaceWithClientID \
  -d client_secret=ReplaceWithClientSecret \
  -d grant_type=refresh_token \
  -d refresh_token=ReplaceWithRefreshToken
*/

async function refreshTokens(currentRefreshToken){
  console.log("Calling refreshTokens()...");
  const url = "https://www.strava.com/api/v3/oauth/token";
  try {
    const postData = JSON.stringify({
      client_id: 55374,
      client_secret: process.env.CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: currentRefreshToken,
    });

    const response = await axios.post(url, postData, {
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
      },
    });

    //console.log(response.data);
    //console.log(response.status);
    //console.log(response.statusText);
    //console.log(response.headers);
    //console.log(response.config);

    if (response.status != 200) {
      throw new Error(`Error refreshing tokens. Response status: ${response.status}`);
    }

    return response.data;
  } catch (error) {
    console.error(error.message);
  }
}

fastify.get("/fetch_data", async function (request, reply) {
  try{
  
  let token = request.query.token;
  let lastTime = request.query.lasttime;
  let refreshToken = request.query.refreshtoken;
  let expiresAt = request.query.expiresat;

  console.log("Call to /fetch_data...");
  console.log("\tAccess Token: " + token);
  console.log("\tExpires at: " + expiresAt);
  console.log("\tRefresh Token: " + refreshToken);
  console.log("\tLast time: " + lastTime);

  //TESTING
  //expiresAt = 1000;
  if((expiresAt - 60) <= (Date.now()/1000)){
    console.log("Access token is expired");
    let newTokenResponse = await refreshTokens(refreshToken);
    token = newTokenResponse.access_token;
    expiresAt = newTokenResponse.expires_at;
    refreshToken = newTokenResponse.refresh_token;
  }

  const allData = await fetchAllPages(token, lastTime);

  reply
        .code(200)
        .header('Content-Type', 'application/json; charset=utf-8')
        .header('accesstoken', token)
        .header('expiresat', expiresAt)
        .header('refreshtoken', refreshToken)
        .send(JSON.stringify(allData));
  } catch (error) {
    console.error('Error handling client request:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }

});

async function fetchAllPages(bearerToken, lastTime) {
  let page = 1;
  let allData = [];
  let hasMoreData = true;

  while (hasMoreData) {
    try {
      const response = await axios.get(`https://www.strava.com/api/v3/athlete/activities?per_page=200&page=${page}&after=${lastTime}`,
        {
          headers: {
            Authorization: "Bearer " + bearerToken,
          },
        });
      const data = response.data;

      if (data.length === 0) {
        hasMoreData = false;
      } else {
        allData = allData.concat(data);
        page++;
      }
    } catch (error) {
      console.error('Error fetching data from Strava:', error);
      throw error;
    }
  }

  return allData;
}

// Run the server and report out to the logs
fastify.listen(
  { port: process.env.PORT, host: "0.0.0.0" },
  function (err, address) {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`Your app is listening on ${address}`);
  }
);
