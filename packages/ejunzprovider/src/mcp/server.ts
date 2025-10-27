#!/usr/bin/env node

import { startMcpServer } from './time';

startMcpServer().catch(error => {
    console.error('Failed to start MCP server:', error);
    process.exit(1);
});

