// node ./route_guide_server.js --db_path=./route_guide_db.json

var PROTO_PATH = './file-info.proto';

const { v4: uuidv4 } = require('uuid');
var fs = require('fs');
var parseArgs = require('minimist');
var path = require('path');
var _ = require('lodash');
var grpc = require('@grpc/grpc-js');
var protoLoader = require('@grpc/proto-loader');
var packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
});
var proto = grpc.loadPackageDefinition(packageDefinition).fileinfo;
const fileInfosDB = [
  {
    name: '/pictures',
    size: 14104,
    mod: { name: 'mod1' },
    modTime: 1617697183009,
    isDir: true
  },
  {
    name: '/reports',
    size: 1,
    mod: { name: 'mod2' },
    modTime: 1617697183009,
    isDir: true
  }
];
/**
 * getFeature request handler. Gets a request with a point, and responds with a
 * feature object indicating whether there is a feature at that point.
 * @param {EventEmitter} call Call object for the handler to process
 * @param {function(Error, feature)} callback Response callback
 */
function getFileInfos(call, callback) {
  // TODO: find the name path, currently return all files.
  callback(null, { fileinfos: fileInfosDB });
}

function createFileInfo(call, callback) {
  const fi = call.request;
  fi.name = uuidv4();
  fileInfosDB.push(fi);
  callback(null, fi);
}

/**
 * listFeatures request handler. Gets a request with two points, and responds
 * with a stream of all features in the bounding box defined by those points.
 * @param {Writable} call Writable stream for responses with an additional
 *     request property for the request value.
 */
function listFeatures(call) {
  var lo = call.request.lo;
  var hi = call.request.hi;
  var left = _.min([lo.longitude, hi.longitude]);
  var right = _.max([lo.longitude, hi.longitude]);
  var top = _.max([lo.latitude, hi.latitude]);
  var bottom = _.min([lo.latitude, hi.latitude]);
  // For each feature, check if it is in the given bounding box
  _.each(feature_list, function(feature) {
    if (feature.name === '') {
      return;
    }
    if (
      feature.location.longitude >= left &&
      feature.location.longitude <= right &&
      feature.location.latitude >= bottom &&
      feature.location.latitude <= top
    ) {
      call.write(feature);
    }
  });
  call.end();
}

/**
 * Calculate the distance between two points using the "haversine" formula.
 * The formula is based on http://mathforum.org/library/drmath/view/51879.html.
 * @param start The starting point
 * @param end The end point
 * @return The distance between the points in meters
 */
function getDistance(start, end) {
  function toRadians(num) {
    return (num * Math.PI) / 180;
  }
  var R = 6371000; // earth radius in metres
  var lat1 = toRadians(start.latitude / COORD_FACTOR);
  var lat2 = toRadians(end.latitude / COORD_FACTOR);
  var lon1 = toRadians(start.longitude / COORD_FACTOR);
  var lon2 = toRadians(end.longitude / COORD_FACTOR);

  var deltalat = lat2 - lat1;
  var deltalon = lon2 - lon1;
  var a =
    Math.sin(deltalat / 2) * Math.sin(deltalat / 2) +
    Math.cos(lat1) *
      Math.cos(lat2) *
      Math.sin(deltalon / 2) *
      Math.sin(deltalon / 2);
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * recordRoute handler. Gets a stream of points, and responds with statistics
 * about the "trip": number of points, number of known features visited, total
 * distance traveled, and total time spent.
 * @param {Readable} call The request point stream.
 * @param {function(Error, routeSummary)} callback The callback to pass the
 *     response to
 */
function recordRoute(call, callback) {
  var point_count = 0;
  var feature_count = 0;
  var distance = 0;
  var previous = null;
  // Start a timer
  var start_time = process.hrtime();
  call.on('data', function(point) {
    point_count += 1;
    if (checkFeature(point).name !== '') {
      feature_count += 1;
    }
    /* For each point after the first, add the incremental distance from the
     * previous point to the total distance value */
    if (previous != null) {
      distance += getDistance(previous, point);
    }
    previous = point;
  });
  call.on('end', function() {
    callback(null, {
      point_count: point_count,
      feature_count: feature_count,
      // Cast the distance to an integer
      distance: distance | 0,
      // End the timer
      elapsed_time: process.hrtime(start_time)[0]
    });
  });
}

var route_notes = {};

/**
 * Turn the point into a dictionary key.
 * @param {point} point The point to use
 * @return {string} The key for an object
 */
function pointKey(point) {
  return point.latitude + ' ' + point.longitude;
}

/**
 * routeChat handler. Receives a stream of message/location pairs, and responds
 * with a stream of all previous messages at each of those locations.
 * @param {Duplex} call The stream for incoming and outgoing messages
 */
function routeChat(call) {
  call.on('data', function(note) {
    var key = pointKey(note.location);
    /* For each note sent, respond with all previous notes that correspond to
     * the same point */
    if (route_notes.hasOwnProperty(key)) {
      _.each(route_notes[key], function(note) {
        call.write(note);
      });
    } else {
      route_notes[key] = [];
    }
    // Then add the new note to the list
    route_notes[key].push(JSON.parse(JSON.stringify(note)));
  });
  call.on('end', function() {
    call.end();
  });
}

/**
 * Get a new server with the handler functions in this file bound to the methods
 * it serves.
 * @return {Server} The new server object
 */
function getServer() {
  var server = new grpc.Server();
  server.addService(proto.FileInfoService.service, {
    getFileInfos: getFileInfos,
    createFileInfo: createFileInfo
    // listFeatures: listFeatures,
    // recordRoute: recordRoute,
    // routeChat: routeChat
  });
  return server;
}

if (require.main === module) {
  // If this is run as a script, start a server on an unused port
  var routeServer = getServer();
  routeServer.bindAsync(
    '0.0.0.0:50051',
    grpc.ServerCredentials.createInsecure(),
    () => {
      var argv = parseArgs(process.argv, {
        string: 'db_path'
      });
      fs.readFile(path.resolve(argv.db_path), function(err, data) {
        if (err) throw err;
        feature_list = JSON.parse(data);
        routeServer.start();
      });
    }
  );
}

exports.getServer = getServer;
