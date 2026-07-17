const express = require('express');
const path = require('path');

const app = express();
const port = 3000;

// Serve static files (HTML, JS, CSS) from the current directory
app.use(express.static(path.join(__dirname)));

app.listen(3000, "0.0.0.0", () => {

  console.log(`
  UltraLink server is running!
  Open your browser and go to http://localhost:${port}
  `);
});