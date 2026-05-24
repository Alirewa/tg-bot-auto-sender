module.exports = {
  apps: [
    {
      name: 'tg-bot-auto-sender',
      script: 'dist/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      time: true,
      // Raise file-descriptor limit so we can run hundreds of parallel TCP probes.
      node_args: ['--max-old-space-size=512'],
      env: {
        NODE_ENV: 'production',
        UV_THREADPOOL_SIZE: '64',
      },
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      merge_logs: true,
    },
  ],
};
