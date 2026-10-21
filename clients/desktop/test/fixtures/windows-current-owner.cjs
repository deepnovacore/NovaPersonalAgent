'use strict'

const {prepareWindowsSmokeHomeOwnership} = require('../../scripts/windows-smoke-home.mjs')

function bindWindowsCurrentOwner(path) {
  prepareWindowsSmokeHomeOwnership({home: path, environment: process.env})
}

module.exports = {bindWindowsCurrentOwner}
