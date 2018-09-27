#! /bin/bash
# Sets the confir params for heroku
# Uses command line parameter and env variables to populate fields in the template file.

# Source the env file to get values for the business org credentials
. ./.env

# Check for variables from env file
if [ -z $LISTENER_APPNAME ]
then
	echo "App name for Listener must be defined in .env file"
	exit 1
fi

#Create a new heroku app
NUMBER=$RANDOM
APPNAME="pe-quickstart-worker-"
APPNAME+=${NUMBER}
heroku create ${APPNAME}

#Attach heroku to git and push the code
#git push heroku master

#Add redis on to the new heroku app
heroku addons:attach ${LISTENER_APPNAME}::REDIS --app ${APPNAME}