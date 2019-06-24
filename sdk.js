const PROTO_PATH = __dirname + '/plugin.proto';

const _ = require('lodash');
const grpc = require('grpc');
const grpcHealth = require('./node_modules/grpc-health-check/health');
const grpcHealthMessages = require('./node_modules/grpc-health-check/v1/health_pb');
const fnv = require('fnv-plus');
const fs = require('fs');
const protoLoader = require('@grpc/proto-loader');
const packageDefinition = protoLoader.loadSync(
    PROTO_PATH,
    {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true
    });
const plugin = grpc.loadPackageDefinition(packageDefinition).proto;

// Core protocol version is the protocol version of the plugin system itself.
const CORE_PROTOCOL_VERS = 1;

// Protocol version currently in use by Gaia.
const PROTOCOL_VERS = 2;

// Protocol type is the type used to communicate.
const PROTOCOL_TYPE = 'grpc';

// Listen domain (usually localhost)
const LISTEN_URL = 'localhost:';

// Get the path from mTLS certs via ENV variables
const SERVER_CERT_PATH = process.env.GAIA_PLUGIN_CERT;
const SERVER_KEY_PATH = process.env.GAIA_PLUGIN_KEY;
const ROOT_CA_CERT_PATH = process.env.GAIA_PLUGIN_CA_CERT;

const ERR_EXIT_PIPELINE = 'pipeline exit requested by job';

let cached_jobs = [];

// getJobs streams all cached jobs back to the caller.
function getJobs(call) {
    _.each(cached_jobs, function (job) {
        call.write(job);
    });
    call.end();
}

// executeJob accepts one job which will be executed.
// It returns a JobResult object which includes information about the run.
function executeJob(call, callback) {
    // Find matching job in the cached job list
    let job = null;
    let reqJob = call.request;
    for (let i = 0; i < cached_jobs.length; i++) {
        if (cached_jobs[i].uniqueId() === reqJob.uniqueId()) {
            job = cached_jobs[i];
        }
    }
    if (!job) {
        throw new Error('Job not found in plugin: ' + reqJob.toString());
    }

    // Start user defined job
    let jobResult = {};
    try {
        job.handler(reqJob.arguments);
    } catch (ex) {
        if (ex.toString() === ERR_EXIT_PIPELINE) {
            jobResult.failed = true;
        }

        // Set other related information
        jobResult.exit_pipeline = true;
        jobResult.message = ex.toString();
        jobResult.unique_id = reqJob.uniqueId();
    }

    // Send JobResult obj
    callback(null, jobResult);
}

function Serve(jobs) {
    // Iterate all given jobs
    for (let i = 0; i < jobs.length; i++) {
        // Generate and set fnv 32bit hash
        jobs[i].unique_id = fnv.hash(jobs[i].title);

        // Resolve dependent jobs
        if (jobs[i].depends_on) {
            let newDependsOn = [];
            for (let z = 0; z < jobs[i].depends_on.length; z++) {
                let foundDep = false;
                for (let x = 0; x < jobs.length; x++) {
                    if (jobs[i].depends_on[z].toLowerCase() === jobs[i].title.toLowerCase()) {
                        foundDep = true;
                        newDependsOn.push(fnv.hash(jobs[i].title));
                    }
                }

                if (!foundDep) {
                    throw new Error('job ' + jobs[i].title + ' has dependency ' + jobs[i].depends_on[z] + ' which is not declared');
                }
            }

            // Set new depends on list
            jobs[i].depends_on = newDependsOn;
        }

        // Check if two jobs have the same title which is restricted
        for (let x = 0; x < jobs.length; x++) {
            if (i !== x && jobs[i].title === jobs[x].title) {
                throw new Error('duplicate job found (two jobs with the same title): ' + jobs[i].title);
            }
        }
    }
    cached_jobs = jobs;

    // Check if certificates exists
    if (!fs.existsSync(SERVER_CERT_PATH)) {
        throw new Error('cannot find path to certificate');
    }
    if (!fs.existsSync(SERVER_KEY_PATH)) {
        throw new Error('cannot find path to key');
    }
    if (!fs.existsSync(ROOT_CA_CERT_PATH)) {
        throw new Error('cannot find path to root CA certificate');
    }

    // Setup mTLS credentials
    let credentials = grpc.ServerCredentials.createSsl(fs.readFileSync(ROOT_CA_CERT_PATH), [{
        cert_chain: fs.readFileSync(SERVER_CERT_PATH),
        private_key: fs.readFileSync(SERVER_KEY_PATH)
    }], true);

    // Setup health service and gRPC server
    let server = new grpc.Server();
    let healthService = new grpcHealth.Implementation({
        '': grpcHealthMessages.HealthCheckResponse.ServingStatus.SERVING
    });
    server.addService(grpcHealth.service, healthService);
    server.addService(plugin.Plugin.service, {
        getJobs: getJobs,
        executeJob: executeJob
    });
    let port = server.bind(LISTEN_URL, credentials);

    // Print connection information
    console.log(CORE_PROTOCOL_VERS + '|'
        + PROTOCOL_VERS + '|'
        + 'tcp|'
        + LISTEN_URL + port + '|'
        + PROTOCOL_TYPE);

    // Start server
    server.start();
}

module.exports = {
    Serve: Serve
};

let myjobs = [{
    title: 'test job',
    description: 'test desc',
    handler: function () {
        console.log('test 123');
    }
}];

Serve(myjobs);