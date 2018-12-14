// Copyright (c) 2018-present, salesforce.com, inc. All rights reserved
// Licensed under BSD 3-Clause - see LICENSE.txt or git.io/sfdc-license

// If running locally, install redis first:
// https://redis.io/
// then:
// $ npm install redis online
// $ redis-server

/**
 * Module dependencies.
 */
let express = require('express');
let bodyParser = require("body-parser");
let redis = require('redis');
let jsforce = require('jsforce');

/**
 * Setup environment variables, with defaults in case not present 
 */
let PORT = process.env.PORT || 3000;
let REDIS_URL = process.env.REDIS_URL;

/**
 * Initialize redis
 */
let redisClient = redis.createClient(REDIS_URL);

redisClient.on("error", function (err) {
  console.log("Redis error " + err);
});

/**
 * Initialize app and listen on port
 */
//Here we are configuring express to use body-parser as middle-ware.
let app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.listen(PORT, () => console.log(`Express server listening on ${PORT}`));

/**
 * Handle POST requests for worker to process an event
 */
app.post('/processEvent', function(req, res, next) {
  //console.log('In processEvent handler.  Received request with body: ' + JSON.stringify(req.body));

  var orgId = req.body.orgId;
  var eventId = req.body.eventId;
  var recordIds = req.body.recordIds;
  var namespace = req.body.namespace;
  //var connString;
  var connInfo; // = req.body.connInfo;
  var displayString = '';
  
  if (eventId && orgId) {
      displayString += 'Success! Received event with ID = ' + eventId + ' for org: ' + orgId + ' with namespace: ' + namespace;
      console.log('Success! Received event with Id: ' + eventId + ' for org: ' + orgId + ' with namespace: ' + namespace);

      redisClient.hget(orgId, "conn_string", function (err, reply) {
        if (err) {
          console.log('Redis get err: ' + err);
        }
        if (reply) {
          console.log('Got reply with connection info for org');
          connInfo = JSON.parse(reply);

          console.log('Connection Info: ' + JSON.stringify(connInfo));
          displayString += ' and Connectioon Info: ' + JSON.stringify(connInfo);
          var sfdc = getPreauthenticatedConnection(connInfo.oauth);

          if (recordIds) {
            console.log('RecordIds: ' + recordIds);
            displayString += ' and recordIds: ' + recordIds;
            processRecords(sfdc, connInfo.oauth, orgId, eventId, recordIds, namespace);
          } else {
            console.log('No Record Ids provided.');
            displayString += '.  No Record Ids provided';
          }
        }
      });

  } else {
    // No event ID
    console.log('Error: No Event / Org Id provided.');
    displayString += 'Error: No Event Id provided';
  }
  res.send(displayString);
});

/**
 * Get connection to Salesforce using jsforce
 */
 function getPreauthenticatedConnection(oauth) {

    var org = new jsforce.Connection({
        instanceUrl: oauth.instance_url,
        accessToken: oauth.access_token
    });

    console.log('jsforce org: ' + org);
    return org;
}

/**
 * Call into Salesforce to process the recordIds passed in
 */
 function processRecords(sfdc, oauth, orgId, eventId, recordIds, namespace) {
    console.log('In processRecords method.'); // with sfdc: ' + sfdc + ' and recordIds: ' + recordIds + ' and oauth: ' + JSON.stringify(oauth));

    // Set the combined key for redis to <orgID>-<eventId> and determine the attempt_count to use
    let status = "Processed";
    let redisKey = orgId + '-' + eventId;
    redisClient.hget(redisKey, "attempt_count", function (err, reply) {
      if (err) {
        console.log('Redis get attempt_count err: ' + err);
      }
      if (reply) {
        count = reply + 1;
      }
    });

    // Format record ID's to be be used in IN clause
    var recordString = recordIds.replace(/\"/g, "'").replace("[", "(").replace("]", ")");
    var lastProcessedField = namespace ? (namespace + '__Last_Processed_TS__c') : 'Last_Processed_TS__c';    

    // Define the query to use to fetch data from the customer org
    var q = 'SELECT Id, ' + lastProcessedField + ', FirstName, LastName FROM Contact WHERE Id IN ' + recordString;

    // Execute the query, and perform logic to update each record
    var contacts = [];
    var result = sfdc.query(q)
      .on("record", function(contact) {
        console.log('Processing Contact with Name: ' + contact.FirstName + ' ' + contact.LastName);
        contact[lastProcessedField] = Date.now();
        contacts.push(contact);
      })
      .on("end", function() {
        console.log("total in database : " + result.totalSize);
        console.log("total fetched : " + result.totalFetched);

        // Multiple records update
        sfdc.sobject("Contact").update(contacts, function(update_err, update_results) {
          if (update_err) { 
            console.error(update_err);
            status = 'Failed';
          } else {
            for (var i=0; i < update_results.length; i++) {
              if (update_results[i].success) {
                console.log("Updated Successfully: " + update_results[i].id);
              } else {
                console.log("Failed to Update: " + update_results[i].id);
                status = 'Failed';
              }
            }
            redisClient.hmset(redisKey, "status", status, "last_update", Date.now(), "attempt_count", count, function(seterr, reply) {
              if (seterr) { console.log('Redis set err: ' + seterr); }
              console.log('Set status for ' + redisKey + ' to: ' + status + ' and attempt_count to: ' + count);
            }); 
          }
        });

      })
      .on("error", function(err) {
        console.error(err);
        status = 'Failed';
        redisClient.hmset(redisKey, "status", status, "last_update", Date.now(), "attempt_count", count, function(seterr, reply) {
          if (seterr) { console.log('Redis set err: ' + seterr); }
          console.log('Set status for ' + redisKey + ' to: ' + status + ' and attempt_count to: ' + count);
        }); 
      })
      .run({ autoFetch : true, maxFetch : 4000 }); // synonym of Query#execute();

};