#!/usr/bin/env node
import {main} from '../src/command.mjs'
try { process.exitCode = await main(process.argv.slice(2)) }
catch (error) { console.error(error.message); process.exitCode = 2 }
