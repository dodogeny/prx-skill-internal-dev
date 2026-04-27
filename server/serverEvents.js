'use strict';

// Shared event bus for cross-module communication within the server process.
// Avoids circular dependencies between index.js and dashboard/routes.js.
const { EventEmitter } = require('events');
module.exports = new EventEmitter();
