'use strict';
exports.load = () => {
  if (!['linux', 'darwin'].includes(process.platform)) {
    throw new Error('Secure qURL state storage requires Linux or macOS');
  }
  return require('node-gyp-build')(__dirname);
};
