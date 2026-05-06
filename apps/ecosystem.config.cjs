module.exports = {
  apps: [
    {
      name: "agti-farm-server",
      cwd: "./server",
      script: "dist/index.js",
      env: {
        NODE_ENV: "production",
        PORT: 8080
      }
    },
    {
      name: "agti-farm-web",
      cwd: "./web",
      script: "node_modules/vite/bin/vite.js",
      args: "preview --host 0.0.0.0 --port 3000",
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
