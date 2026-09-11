module.exports = {
  apps: [{
    name: 'sim-monitor',
    script: 'server.js',
    cwd: __dirname,
    watch: false,
    env: {
      SIM_MODE: '1',
      HTTP_PORT: '3001',
      SSL_PORT: '3444',
      DATA_FILE: require('path').join(__dirname, 'sim-data.json'),
    }
  }]
};
