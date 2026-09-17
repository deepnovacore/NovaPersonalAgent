'use strict'

/** The staged release app has already materialized the complete node_modules graph. */
module.exports = async function beforeBuild() {
  return false
}
