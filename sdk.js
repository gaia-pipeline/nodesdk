var PROTO_PATH = __dirname + '/plugin.proto';

var _ = require('lodash');
var grpc = require('grpc');
var protoLoader = require('@grpc/proto-loader');
var packageDefinition = protoLoader.loadSync(
    PROTO_PATH,
    {keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true
    });
var plugin = grpc.loadPackageDefinition(packageDefinition).proto;

// Core protocol version is the protocol version of the plugin system itself.
const CORE_PROTOCOL_VERS = 1;

// Protocol version currently in use by Gaia.
const PROTOCOL_VERS = 2;

// Protocol type is the type used to communicate.
const PROTOCOL_TYPE = 'grpc';

// Listen domain (usually localhost)
const LISTEN_URL = 'localhost:';

// Env variable key names for TLS cert path
const SERVER_CERT_ENV = 'GAIA_PLUGIN_CERT';
const SERVER_KEY_ENV = 'GAIA_PLUGIN_KEY';
const ROOT_CA_CERT_ENV = 'GAIA_PLUGIN_CA_CERT';

const ERR_EXIT_PIPELINE = 'pipeline exit requested by job';

var cached_jobs = [];

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
    let jobResult = {}
    try {
       job.funcPointer(reqJob.arguments);
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

function serve() {
    var server = new grpc.Server();
    server.addService(plugin.Plugin.service, {
        getJobs: getJobs,
        executeJob: executeJob
    });
    server.bind('0.0.0.0:50051', grpc.ServerCredentials.createInsecure());
    server.start();
}

serve();