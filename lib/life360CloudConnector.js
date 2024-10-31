"use strict";

let adapter;

//  Load core-modules ...
const Promise = require("bluebird");
const request = Promise.promisify(require("request"));

const retryRequest = Promise.promisify(require("retry-request", {
    request: require("request")
}));

Promise.promisifyAll(request);

const { v4: uuidv4 } = require("uuid");

//  ioBroker specific modules
const iobHelpers = require("./iobHelpers");
const myLogger = new iobHelpers.IobLogger(adapter);

/**
 * Hard-coded "CLIENT_SECRET": Has to be identified and verified after Life360 publishes a new version of the mobile app!
 */
const LIFE360_CLIENT_SECRET = "U3dlcUFOQWdFVkVoVWt1cGVjcmVrYXN0ZXFhVGVXckFTV2E1dXN3MzpXMnZBV3JlY2hhUHJlZGFoVVJhZ1VYYWZyQW5hbWVqdQ==";
const DEFAULT_CLIENT_VERSION = "22.6.0.532";
const DEFAULT_USER_AGENT = "SafetyMapKoko";

/**
 * The Life360 API URIs.
 * - login URL
 * - circles URL
 */
const LIFE360_URL = {
    login: "https://api-cloudfront.life360.com/v5/users/signin/otp/send",
    verifyOtp: "https://api-cloudfront.life360.com/v5/users/signin/otp/token",
    circles: "https://api-cloudfront.life360.com/v4/circles",
    members: "https://api-cloudfront.life360.com/v4/circles/{circleId}/members",
    devices: "https://api-cloudfront.life360.com/v5/circles/devices",
    deviceLocations: "https://api-cloudfront.life360.com/v5/circles/devices/locations?providers%5B%5D=life360&providers%5B%5D=tile&providers%5B%5D=jiobit"
};


const min_polling_interval = 15;    //  Min polling interval in seconds
const maxAgeToken = 300;            //  Max age of the Life360 token in seconds
let objTimeoutConnection = null;    //  Connection Timeout id
let objIntervalPoll = null;         //  Poll Interval id
let countOnlineOperations = 0;      //  How many online operations are running?
let adapterConnectionState = false; //  Life360 connection status.
const Life360APIDataMaxRetries = 5; //  Max retries to poll data from the Life360 API if the API does not throw an error.
const Life360APIMaxRetries = 5;     //  Max retries for http-requests against the Life360 API

let life360_username = process.env.LIFE360_USERNAME;
let life360_password = process.env.LIFE360_PASSWORD;
let life360_phone = process.env.LIFE360_PHONE;
let life360_countryCode = process.env.LIFE360_COUNTRYCODE;
let life360_otp = process.env.LIFE360_OTP;

const deviceId = uuidv4();
const clientVersion = DEFAULT_CLIENT_VERSION;
const userAgent = DEFAULT_USER_AGENT;

/**
 * Stores authentication information for the current session.
 * - access token
 * - type of token
 */
let auth = {
    access_token: null,
    token_type: null
};
  
/**
 * Stores the data retrieved from Life360 cloud services.
 */
let cloud_data = {
    circles: [],
    deviceLocations: []
};

/**
 * Returns the number of pending online operations against Life360 cloud services.
 */
function getCurrentOnlineOperations() {
    return countOnlineOperations;
}

/**
 * Notify the Life360 cloud connector about starting a new online operation.
 */
function startOnlineOperation() {
    countOnlineOperations += 1;
    logger("silly", `Current online operations: ${countOnlineOperations}.`);
    return countOnlineOperations;
}

/**
 * Notify the Life360 cloud connector about finished an online operation.
 */
function stopOnlineOperation() {
    countOnlineOperations -= 1;
    if (countOnlineOperations < 0) countOnlineOperations = 0;
    logger("silly", `Current online operations: ${countOnlineOperations}.`);
    return countOnlineOperations;
}

/**
 * Simple sleep function.
 * @param {number} milliseconds Time to sleep (ms.).
 */
function Sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/**
 * Logger is a wrapper for logging.
 * @param {*} level Set to "error", "warn", "info", "debug"
 * @param {*} message The message to log
 */
function logger(level, message) {
    myLogger.logger(level, message);
}

/**
 * Updates the Life360 connector's state for the ioBroker instance.
 * @param {boolean} isConnected Set to true if connected.
 */
function setAdapterConnectionState(isConnected) {
    if (!adapter) {
        //  No adapter instance set.
    }
    else {
        // Issue #9: check Adapter with js-controller 3.0.x
        adapter.setState("info.connection", isConnected, true);
        if (isConnected != adapterConnectionState) {
            if (isConnected)
                myLogger.info("Connected to Life360 cloud services.");
            else
                myLogger.info("Disconnected from Life360 cloud services.");
        }
        adapterConnectionState = isConnected;
    }
}

/**
 * Encode an uriComponent for application/x-www-form-urlencoded content.
 * @param {*} uriComponent 
 * @returns application/x-www-form-urlencoded compliant encoded uriComponent
 * 
 * The encodeURIComponentForm() function encodes a URI by replacing each 
 * instance of certain characters by one, two, three, or four escape 
 * sequences representing the UTF-8 encoding of the character (will only be 
 * four escape sequences for characters composed of two "surrogate" characters).
 * 
 * For application/x-www-form-urlencoded, spaces are to be replaced by +.
 */
function encodeURIComponentForm(uriComponent) {
    return encodeURIComponent(uriComponent).replace("%20", "+");
}

/** 
 * Set ioBroker adapter instance for the connector
 *  @param {*} adapter_in The adapter instance for this connector.
*/
exports.setAdapter = function(adapter_in) {
    adapter = adapter_in;
    myLogger.setAdapter(adapter);

    life360_username = adapter.config.life360_username;
    life360_password = adapter.config.life360_password;
    life360_phone = adapter.config.life360_phone;
    life360_countryCode = adapter.config.life360_countryCode;
    life360_otp = adapter.config.life360_otp;
};

/**
 * Request OTP using either email or phone.
 */
async function requestOTP() {
    const body = life360_username
        ? { email: life360_username }
        : { countryCode: life360_countryCode, nationalNumber: life360_phone };
    
    const options = {
        url: LIFE360_URL.login,
        method: "POST",
        headers: {
            "Authorization": `Basic ${LIFE360_CLIENT_SECRET}`,
            "Content-Type": "application/json",
            "User-Agent": userAgent
        },
        body,
        json: true
    };

    try {
        const response = await request(options);
        if (response.body.data && response.body.data.transactionId) {
            return response.body.data.transactionId;
        } else {
            throw new Error("OTP request failed");
        }
    } catch (error) {
        logger("error", "Error requesting OTP: " + error);
        throw error;
    }
}

/**
 * Verify OTP and retrieve access token.
 * @param {string} otpCode The OTP code to verify.
 * @param {string} transactionId The transaction ID from OTP request.
 */
async function verifyOTP(otpCode, transactionId) {
    const options = {
        url: LIFE360_URL.verifyOtp,
        method: "POST",
        headers: {
            "Authorization": `Basic ${LIFE360_CLIENT_SECRET}`,
            "Content-Type": "application/json",
            "User-Agent": userAgent
        },
        body: {
            code: otpCode,
            transactionId: transactionId
        },
        json: true
    };

    try {
        const response = await request(options);
        if (response.body.access_token) {
            auth.access_token = response.body.access_token;
            auth.token_type = response.body.token_type;
            return auth;
        } else {
            throw new Error("OTP verification failed");
        }
    } catch (error) {
        logger("error", "Error verifying OTP: " + error);
        throw error;
    }
}


/**
 * Connect to the Life360 service.
 * Specify a username OR both a phone number and country code.
 * @param {*} username Life360 username, or undefined if phone specified.
 * @param {*} password Life360 password.
 * @param {*} phone Life360 phone, or undefined if username specified.
 * @param {*} countryCode Optional phone country code, defaults to 1 if not specified.
 */
exports.connectLife360 = function(username, password, phone, countryCode) {
    return new Promise((resolve, reject) => {
        if(!username || typeof username === "function") username = life360_username;
        if(!password || typeof password === "function") password = life360_password;
        if(!phone || typeof phone === "function") phone = life360_phone;
        if(!countryCode || typeof countryCode === "function") countryCode = life360_countryCode;

        logger("debug", "Connecting to Life360 service  ...");

        auth = {
            access_token: null,
            token_type: null
        };

        countryCode = typeof countryCode !== "undefined" ? countryCode : 1;
        username = typeof username !== "undefined" ? username : "";
        phone = typeof phone !== "undefined" ? phone : "";
        // if(!password) throw new Error("Life360: No password specified.");

        const options = {
            url: LIFE360_URL.login,
            method: "POST",
            body: {
                grant_type: "password",
                username: username,
                password: password,
                countryCode: countryCode,
                phone: phone
            },
            headers: {
                "Authorization": `Authorization: Basic ${LIFE360_CLIENT_SECRET}`,
                "Content-Type" : "application/json",
                "X-Device-ID": deviceId,
                "User-Agent": `${userAgent}/${clientVersion}/${deviceId}`
            },
            json: true
        };
        
        request(options)
            .then(response => {
                if ((response.statusMessage === "Forbidden") || !response.body["access_token"]) {
                    auth = {
                        access_token: null,
                        token_type: null
                    };
    
                    logger("error", "Connection established but failed to authenticate. Check your credentials!");
                    logger("debug", "Auth tokens deleted.");
    
                    reject(new Error("Connection established but failed to authenticate. Check your credentials!"));
                }
                else {
                    auth = {
                        access_token: response.body["access_token"],
                        token_type: response.body["token_type"]
                    };
    
                    logger("debug", `Logged in as user: ${username}, phone: ${phone} .`);
                    logger("debug", "Saved auth tokens.");

                    resolve(auth);
                }
            })
            .catch(err => {
                setAdapterConnectionState(false);
                reject(new Error("Unable to connect: " + err));
            });
    });
};

/**
 * Ensures connection to the Life360 service.
 */
exports.connect = async function() {
    try {
        // Step 1: Request OTP
        const transactionId = await requestOTP();

        // Wait for OTP entry in UI (replace with real input method for OTP in production)
        const otpCode = life360_otp; // Replace this with actual OTP retrieval

        // Step 2: Verify OTP
        await verifyOTP(otpCode, transactionId);

        // Connection successful
        setAdapterConnectionState(true);
        return auth;
    } catch (error) {
        setAdapterConnectionState(false);
        logger("error", "Connection failed: " + error);
        throw error;
    }
};


/**
 * Disconnect from Life360 (i.e. clear all tokens)
 */
exports.disconnect = async function() {
    clearTimeout(objTimeoutConnection);

    if (getCurrentOnlineOperations() > 0) {
        logger("info", "Waiting for online operations to finish ...");
        while (getCurrentOnlineOperations() != 0) {
            await Sleep(1000);
            logger("silly", `  - Pending operations: ${getCurrentOnlineOperations()}.`);
        }
    }

    auth = {
        access_token: null,
        token_type: null
    };

    logger("debug", "Auth tokens deleted.");
    // logger("info", "Disconnected from Life360.");
};

/**
 * Returns true if connected to Life360 cloud services.
 */
exports.is_connected = function() {
    return auth.access_token;
};

/**
 * Returns the authentication information for Life360.
 */
exports.get_auth = function () {
    return auth;
};

/**
 * Returns a list of the user's Life360 circles.
 */
exports.getCircles = function(auth_in) {
    return new Promise((resolve, reject) => {
        if (!auth_in) auth_in = auth;

        const options = {
            url: LIFE360_URL.circles,
            headers: {
                "Authorization": `${auth_in.token_type} ${auth_in.access_token}`
            },
            json: true
        };

        logger("silly", `Retrieving circles at ${LIFE360_URL.circles}`);

        request(options)
            .then(response => {
                if (!response.body.circles) {
                    logger("error", "No circles found!");
                    reject(new Error("No circles found!"));
                }
                else {
                    if (response.body.circles.length == 0) {
                        logger("error", "No circles in your Life360.");
                        reject(new Error("No circles in your Life360."));
                    }
                    else {
                        logger("debug", "Retrieved circles.");
                        resolve(response.body.circles);
                    }
                }
            })
            .catch(err => {
                reject(new Error("Unable to poll circles: " + err));
            });
    });
};

/**
 * Returns details for a Life360 circle identified by the the circle's id.
 */
exports.getCircleById = function(auth_in, circleId) {
    return new Promise((resolve, reject) => {
        if (!auth_in) auth_in = auth;

        const LIFE360_CIRCLE_URL = `${LIFE360_URL.circles}/${circleId}`;
        const options = {
            url: LIFE360_CIRCLE_URL,
            headers: {
                "Authorization": `${auth_in.token_type} ${auth_in.access_token}`
            },
            json: true
        };

        logger("silly", `Retrieving circle at ${LIFE360_CIRCLE_URL}`);

        request(options)
            .then(response => {
                logger("silly", `Retrieved circle with id ${circleId} !`);
                resolve(response.body);
            })
            .catch(err => {
                reject(new Error(`Unable to poll circle with ID ${circleId}: ${err}`));
            });
    });
};

/**
 * Deprecated.
 */
exports.getCircleMembersPromise = function(circle_in) {
    return new Promise((resolve, reject) => {
        if (!circle_in) {
            reject(new Error("Provide a circle object, please."));
        }
        else {
            const members = [];

            if (circle_in.members.length == 0) {
                console.log("Circle has no members.");
            }
            else {
                for (let oMember in circle_in.members) {
                    let member = circle_in.members[oMember];
                    members.push( {id: member.id, json: member} );
                }
            }

            resolve(members);
        }
    });
};

/**
 * Returns an array conaining a circle's members.
 */
exports.getCircleMembers = function(circle_in) {
    const members = [];

    if (!circle_in) {
        logger("error", "Provide a circle object, please.");
    }
    else {
        if (circle_in.members.length == 0) {
            logger("debug", "Circle has no members.");
        }
        else {
            for (let oMember in circle_in.members) {
                let member = circle_in.members[oMember];
                members.push( {id: member.id, json: member} );
            }
        }
    }

    return members;
};

/**
 * Disables automatic polling.
 */
exports.disablePolling = function() {
    if (objIntervalPoll) {
        clearTimeout(objIntervalPoll);
        logger("info", "Disabled polling.");

    }
};

/**
 * Enables automatic polling.
 */
exports.setupPolling = function(callback) {
    let polling_interval = min_polling_interval;

    if (!adapter) 
        polling_interval = Number(process.env.LIFE360_POLLING_INTERVAL); 
    else
        polling_interval = Number(adapter.config.life360_polling_interval);

    if (polling_interval < min_polling_interval) {
        logger("error", "Polling interval should be greater than " + min_polling_interval);

        return false;
    } else {
        exports.disablePolling();

        // exports.poll(callback);
        exports.pollAsync(callback);
  
        // Enable polling
        objIntervalPoll = setInterval(() => {
            // exports.poll(callback);
            exports.pollAsync(callback);
        }, polling_interval * 1000);

        logger("info", `Polling enabled every ${polling_interval} seconds.`);
        return true;
    }
};

/**
 * Initiates an async Life360 cloud data poll and passes the data to a callback function.
 * @param {Function} callback The callback function.
 */
exports.pollAsync = function(callback) {
    myLogger.debug("Fetching Life360 cloud data ...");
    pollLife360DataAsync()
        .then(cloud_data => {
            if (callback) {
                logger("debug", "Pushing cloud_data to callback function");
                callback(false, cloud_data);
            }
            return true;
        })
        .catch(err => {
            if (callback) {
                callback(err, null);
            }
            else {
                logger("error", `Error polling Life360 data: ${err}`);
            }
            return false;
        });
};

/**
 * Polls (async) the Life360 cloud data.
 */
async function pollLife360DataAsync() {
    cloud_data.circles = [];
    cloud_data.deviceLocations = [];

    try {
        //  Ensure we are connected and authorized
        startOnlineOperation();
        // const auth_in = await exports.connect();
        let auth_in = false;
        let counter = 0;
        let lastError = false;

        do {
            counter++;
            logger("silly", `Ensure we are connected and authorized ... try #${counter}`);

            try {
                auth_in = await exports.connect();
            } catch (error) {
                auth_in = false;
                lastError = error;
            }
        } while ((counter <= Life360APIDataMaxRetries) && (!auth_in));

        if (!auth_in) {
            //  Failed to connect or to login
            logger("error", `Failed to connect or to login for ${counter} times. Aborting ...`);
            throw(lastError);
        }

        //  Connected. Start polling Life360 data.

        //  First poll the user's circles.
        const circles = await exports.getCirclesAsync(auth_in);

        for (let c in circles) {
            const circle = circles[c];
            logger("silly", `circle ${circle.id} --> ${circle.name}`);
            
            //  Get circle's members
            const circleMembers = await exports.getCircleMembersAsync(auth_in, circle.id);
            circle.members = circleMembers;
            logger("silly", `  - ${circle.members.length} member(s) found.`);

            //  Get circle's places
            const circlePlaces = await exports.getCirclePlacesAsync(auth_in, circle.id);
            circle.places = circlePlaces;
            logger("silly", `  - ${circle.places.length} place(s) found.`);
        }
        cloud_data.circles = circles;

        // Fetch device locations for all circles
        try {
            const deviceLocationsResponse = await request({
                url: LIFE360_URL.deviceLocations,
                headers: { "Authorization": `${auth.token_type} ${auth.access_token}` },
                json: true
            });
            cloud_data.deviceLocations = deviceLocationsResponse.body.devices || [];
            logger("debug", `Fetched ${cloud_data.deviceLocations.length} device location(s) from Life360.`);
        } catch (error) {
            logger("error", `Failed to retrieve device locations: ${error}`);
            cloud_data.deviceLocations = []; // Ensure it's set to an empty array if fetching fails
        }

        //  Return the retrieved Life360 cloud data
        stopOnlineOperation();
        return cloud_data;
    } catch (error) {
        stopOnlineOperation();
        logger("error", error);
    }
}

/**
 * Returns the Life360 circles.
 * @param {*} auth_in The auth object.
 */
exports.getCirclesAsync = async function(auth_in) {
    if (!auth_in) auth_in = auth;

    const options = {
        url: LIFE360_URL.circles,
        headers: {
            "Authorization": `${auth_in.token_type} ${auth_in.access_token}`
        },
        json: true
    };

    logger("silly", `Async - Retrieving circles at ${LIFE360_URL.circles}`);

    try {
        startOnlineOperation();

        let obj = undefined;

        let counter = 0;

        do {
            counter++;
            if (counter > 1) logger("debug", `Polling Life360 circles... try #${counter}`);

            // const response = await request(options);
            options.retries = Life360APIMaxRetries;
            const response = await retryRequest(options);

            if (response.body && response.body.circles) {
                logger("silly", `Retrieved ${response.body.circles.length} circle(s).`);
                obj = response.body.circles;
            }

        } while ((counter <= Life360APIDataMaxRetries) && (obj === undefined));

        if (obj === undefined) {
            logger("warn", "Life360 circle data expected but missing!");
            obj = [];
        }

        stopOnlineOperation();
        return obj;
    } catch (error) {
        logger("error", `Failed to retrieve members: ${error}`);
        stopOnlineOperation();
    }
    
};

/**
 * Returns the Life360 circle's members.
 * @param {*} auth_in The auth object.
 * @param {*} circleId The id of a Life360 circle.
 */
exports.getCircleMembersAsync = async function(auth_in, circleId) {
    if (!auth_in) auth_in = auth;

    const URL = LIFE360_URL.members;
    const options = {
        url: URL,
        headers: {
            "Authorization": `${auth_in.token_type} ${auth_in.access_token}`
        },
        json: true
    };

    logger("silly", `Retrieving members at ${URL}`);

    try {
        startOnlineOperation();

        let obj = undefined;

        let counter = 0;

        do {
            counter++;
            if (counter > 1) logger("debug", `Polling Life360 members ... try #${counter}`);

            // const response = await request(options);
            options.retries = Life360APIMaxRetries;
            const response = await retryRequest(options);
            
            if (response.body && response.body.members) {
                logger("silly", `Retrieved ${response.body.members.length} member(s).`);
                obj = response.body.members;
            }

        } while ((counter <= Life360APIDataMaxRetries) && (obj === undefined));

        if (obj === undefined) {
            logger("warn", "Life360 member data expected but missing!");
            obj = [];
        }

        stopOnlineOperation();
        return obj;
    } catch (error) {
        logger("error", `Failed to retrieve members: ${error}`);
        stopOnlineOperation();
    }
    
};

/**
 * Returns the Life360 circle's places.
 * @param {*} auth_in The auth object.
 * @param {*} circleId The id of a Life360 circle.
 */
exports.getCirclePlacesAsync = async function(auth_in, circleId) {
    if (!auth_in) auth_in = auth;

    const URL = `${LIFE360_URL.circles}/${circleId}/places`;
    const options = {
        url: URL,
        headers: {
            "Authorization": `${auth_in.token_type} ${auth_in.access_token}`
        },
        json: true
    };

    logger("silly", `Retrieving places at ${URL}`);

    try {
        startOnlineOperation();

        let obj = undefined;

        let counter = 0;

        do {
            counter++;
            if (counter > 1) logger("debug", `Polling Life360 places ... try #${counter}`);

            // const response = await request(options);
            options.retries = Life360APIMaxRetries;
            const response = await retryRequest(options);

            if (response.body && response.body.places) {
                logger("silly", `Retrieved ${response.body.places.length} place(s).`);
                obj = response.body.places;
            }

        } while ((counter <= Life360APIDataMaxRetries) && (obj === undefined));

        if (obj === undefined) {
            logger("warn", "Life360 places data expected but missing!");
            obj = [];
        }

        stopOnlineOperation();
        return obj;
    } catch (error) {
        logger("error", `Failed to retrieve places: ${error}`);
        stopOnlineOperation();
    }
};
