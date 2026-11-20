#!/usr/bin/env node
require("../dist/cli/program")
  .main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
