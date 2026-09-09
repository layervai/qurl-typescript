const { platform } = require('node:process');
exports.loadNativeStateFS = () => {
  if (platform !== 'linux' && platform !== 'darwin') {
    throw new Error('Secure qURL state storage requires Linux or macOS');
  }
  return require('@layervai/qurl-state-fs').load();
};
