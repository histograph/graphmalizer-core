const H = require('highland')
const argv = require('minimist')

const neoBatch = require('./utils/neo4batch')
const Queries = require('./queries')
const inputChecker = require('./input')
const config = require('./config')

const log = require("histograph-logging");

const my_log = new log("graphmalizer");


function Graphmalizer (userConfig) {

  my_log.debug("In function Graphmalizer: " + JSON.stringify(userConfig));

  // store configuration with user overrides
  var conf = config(userConfig)

  // setup neo4j client
  var batchCommit = H.wrapCallback(neoBatch(conf.Neo4J))

  // setup input checker '~ schema validation'
  var checkInput = inputChecker(conf.types)

  // make query (uses config to determine type ~ structure mapping)
  function prepare (o) {
    my_log.debug("In function prepare");
    try {
      var input = checkInput(o)
      var q = Queries.mkQuery(input)

      // we have win!
      my_log.debug("Almost Out function prepare: " + JSON.stringify(q));
      return [q]
    } catch (err) {
      // other than spewing, we ignore errors
      my_log.error("Error in preparing for Graphmalizer: " + err + ", stack " + err.stack);

      // so this request will be flatmapped away
      return [];
    }

  }

  // stream of input streams
  this.inputs = H()

  // merge all inputs, convert to cypher queries and batch up
  var input = this.inputs
    .merge()
    .flatMap(prepare)
    .batchWithTimeOrCount(argv.batchTimeout || conf.batchTimeout, argv.batchSize || conf.batchSize)

  // commit batches sequentially
  var output = input
    .fork()
    .map(batchCommit) // a -> stream b
    .series()
    .errors(function (err, push) {
        my_log.error('GRAPHMALIZER: caught Neo4j error: ' + err.message);
        err_res = {};
        err_res.results.length = -1;
        err_res.duration_ms = -1;
        err_res.results = {};
        push(null,err_res);
      })
    .map(function (r) {
      if( r.results.length !== -1 ){
        my_log.info('GRAPHMALIZER => ' + r.results.length + ' docs, ' + r.duration_ms + 'ms')
      }
      return r
    })
    .pluck('results')

  // zip into [request-batch, response-batch]
  var rr = input
    .fork()
    .zip(output)

  // unzip, flatten batches
  var requests = rr.fork().pluck(0).sequence()
  var responses = rr.fork().pluck(1).sequence()

  // zip back up and turn it into a dictionary
  this.system = requests
    .zip(responses)
    .map(function (rr) {
      my_log.debug("Mapping request " + JSON.stringify(rr[0]) + " with response " + JSON.stringify(rr[1]));    
      return {
        request: rr[0],
        response: rr[1]
      }
    })

  my_log.debug("Out function Graphmalizer");
// now that all streams are setup, ensure schema creatio
// todo, actually this sucks because it cannot be run
// in transaction with write
// this.inputs.write(H([]));//{query: 'schema'}]))
}

// subscribe a stream to the graphmalizer
Graphmalizer.prototype.register = function (stream) { // ensure valid arguments
  my_log.debug("In function register");
  if (stream) {
    if (!H.isStream(stream)) {
      throw new Error('Must pass a (highland) stream')
    }

    // register input stream
    this.inputs.write(stream)
  }
  my_log.debug("Almost out function register");
  // return stream of all request-responses
  return this.system.fork();
}

Graphmalizer.prototype.shutdown = function () {
  my_log.debug("In and Almost out function shutdown");
  // register input stream
  this.inputs.end()
}

module.exports = Graphmalizer
