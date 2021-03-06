var events = require('events');
var util = require('util');

var types = require('./types');
var utils = require('./utils.js');
var FrameHeader = types.FrameHeader;

/**
 * Contains the logic to write all the different types to the frame.
 * @param {Number} opcode
 * @constructor
 */
function FrameWriter(opcode) {
  if (!opcode) {
    throw new Error('Opcode not provided');
  }
  this.buffers = [];
  this.opcode = opcode;
  this.bodyLength = 0;
}

FrameWriter.prototype.add = function(buf) {
  this.buffers.push(buf);
  this.bodyLength += buf.length;
};

FrameWriter.prototype.writeShort = function(num) {
  var buf = new Buffer(2);
  buf.writeUInt16BE(num, 0);
  this.add(buf);
};

FrameWriter.prototype.writeInt = function(num) {
  var buf = new Buffer(4);
  buf.writeInt32BE(num, 0);
  this.add(buf);
};

/** @param {Long} num */
FrameWriter.prototype.writeLong = function(num) {
  this.add(types.Long.toBuffer(num));
};

/**
 * Writes bytes according to Cassandra <int byteLength><bytes>
 * @param {Buffer|null|types.unset} bytes
 */
FrameWriter.prototype.writeBytes = function(bytes) {
  if (bytes === null) {
    //Only the length buffer containing -1
    this.writeInt(-1);
    return;
  }
  if (bytes === types.unset) {
    this.writeInt(-2);
    return;
  }
  //Add the length buffer
  this.writeInt(bytes.length);
  //Add the actual buffer
  this.add(bytes);
};

/**
 * Writes a buffer according to Cassandra protocol: bytes.length (2) + bytes
 * @param {Buffer} bytes
 */
FrameWriter.prototype.writeShortBytes = function(bytes) {
  if(bytes === null) {
    //Only the length buffer containing -1
    this.writeShort(-1);
    return;
  }
  //Add the length buffer
  this.writeShort(bytes.length);
  //Add the actual buffer
  this.add(bytes);
};

/**
 * Writes a single byte
 * @param {Number} num Value of the byte, a number between 0 and 255.
 */
FrameWriter.prototype.writeByte = function (num) {
  this.add(new Buffer([num]));
};

FrameWriter.prototype.writeString = function(str) {
  if (typeof str === "undefined") {
    throw new Error("can not write undefined");
  }
  var len = Buffer.byteLength(str, 'utf8');
  var buf = new Buffer(2 + len);
  buf.writeUInt16BE(len, 0);
  buf.write(str, 2, buf.length-2, 'utf8');
  this.add(buf);
};

FrameWriter.prototype.writeLString = function(str) {
  var len = Buffer.byteLength(str, 'utf8');
  var buf = new Buffer(4 + len);
  buf.writeInt32BE(len, 0);
  buf.write(str, 4, buf.length-4, 'utf8');
  this.add(buf);
};

FrameWriter.prototype.writeStringList = function (values) {
  this.writeShort(values.length);
  values.forEach(this.writeString, this);
};

FrameWriter.prototype.writeCustomPayload = function (payload) {
  var keys = Object.keys(payload);
  this.writeShort(keys.length);
  keys.forEach(function (k) {
    this.writeString(k);
    this.writeBytes(payload[k]);
  }, this);
};

FrameWriter.prototype.writeStringMap = function (map) {
  var keys = [];
  for (var k in map) {
    if (map.hasOwnProperty(k)) {
      keys.push(k);
    }
  }

  this.writeShort(keys.length);

  for(var i = 0; i < keys.length; i++) {
    var key = keys[i];
    this.writeString(key);
    this.writeString(map[key]);
  }
};

/**
 * @param {Number} version
 * @param {Number} streamId
 * @param {Number} [flags] Header flags
 * @returns {Buffer}
 * @throws {TypeError}
 */
FrameWriter.prototype.write = function (version, streamId, flags) {
  var header = new FrameHeader(version, flags || 0, streamId, this.opcode, this.bodyLength);
  var headerBuffer = header.toBuffer();
  this.buffers.unshift(headerBuffer);
  return Buffer.concat(this.buffers, headerBuffer.length + this.bodyLength);
};

/**
 * Represents a queue that process one write at a time (FIFO).
 * @param {Socket} netClient
 * @param {Encoder} encoder
 * @param {ClientOptions} options
 */
function WriteQueue (netClient, encoder, options) {
  WriteQueue.super_.call(this);
  this.netClient = netClient;
  this.encoder = encoder;
  this.isRunning = false;
  this.queue = [];
  this.coalescingThreshold = options.socketOptions.coalescingThreshold;
}

util.inherits(WriteQueue, events.EventEmitter);
/**
 * Enqueues a new request
 * @param {Request} request
 * @param {Function} callback
 */
WriteQueue.prototype.push = function (request, callback) {
  this.queue.push({ request: request, callback: callback});
  this.run();
};

WriteQueue.prototype.run = function () {
  if (!this.isRunning) {
    this.process();
  }
};

WriteQueue.prototype.process = function () {
  var self = this;
  utils.whilst(
    function () {
      return self.queue.length > 0;
    },
    function (next) {
      self.isRunning = true;
      var buffers = [];
      var callbacks = [];
      var totalLength = 0;
      while (totalLength < self.coalescingThreshold && self.queue.length > 0) {
        /** @type {{request: Request, callback: Function}} */
        var writeItem = self.queue.shift();
        try {
          var data = writeItem.request.write(self.encoder);
          totalLength += data.length;
          buffers.push(data);
          callbacks.push(writeItem.callback)
        }
        catch (err) {
          writeItem.callback(err);
          //break and flush what we have
          break;
        }
      }
      if (buffers.length === 0) {
        next();
      }
      self.netClient.write(Buffer.concat(buffers, totalLength), function (err) {
        if (err) {
          // it's not possible to determine if the request was actual received, but stating that it was written
          // we state that the mutation could have been applied
          err.isSocketError = true;
          err.wasRequestWritten = true;
        }
        for (var i = 0; i < callbacks.length; i++) {
          callbacks[i](err);
        }
        //allow IO between writes
        setImmediate(next);
      });
    },
    function () {
      //the queue is empty
      self.isRunning = false;
    }
  );
};

exports.WriteQueue = WriteQueue;
exports.FrameWriter = FrameWriter;
