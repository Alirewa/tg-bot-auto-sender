// PM2 process config tuned for Hetzner CX22 (2 vCPU / 4 GB RAM).
// Override on bigger/smaller boxes by editing max_memory_restart and node_args.
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
      // 4 GB box, give the bot up to 1 GB before pm2 force-restarts.
      max_memory_restart: '1G',
      kill_timeout: 5000,
      time: true,
      // 1 GB V8 heap.
      node_args: ['--max-old-space-size=1024'],
      env: {
        NODE_ENV: 'production',
        // Bigger libuv thread pool so DNS / fs / crypto don't bottleneck the
        // hundreds of in-flight TCP probes.
        UV_THREADPOOL_SIZE: '32',
      },
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      merge_logs: true,
    },
  ],
};
