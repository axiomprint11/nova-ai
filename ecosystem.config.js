// pm2 setup for Nova — cluster mode (one worker) so `pm2 reload axiom-ai` swaps versions with no downtime:
// the new worker boots, says 'ready' (server.js) and only then the old one is stopped. scripts/deploy.sh uses it.
// First time (or after a change here):  cd /opt/axiom-ai && pm2 delete axiom-ai; pm2 start ecosystem.config.js && pm2 save
module.exports = {
  apps: [{
    name: 'axiom-ai',
    script: 'server.js',
    cwd: '/opt/axiom-ai',
    exec_mode: 'cluster',
    instances: 1,
    wait_ready: true,        // wait for process.send('ready') …
    listen_timeout: 30000,   // … up to 30 s; if the new copy never gets there the old one keeps running
    kill_timeout: 12000,     // the old copy gets 12 s to finish open requests after SIGINT
    max_memory_restart: '900M',
    time: true,
    env: { NODE_ENV: 'production' }
  }]
};
