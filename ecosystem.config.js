module.exports = {
  apps: [{
    name: 'equipment-monitor',
    script: 'server.js',
    cwd: 'C:\\Users\\jypark\\equipment-monitor',
    watch: false,
    max_restarts: 10,
    restart_delay: 3000,
    env: {
      NODE_ENV: 'production'
    }
  }]
};
