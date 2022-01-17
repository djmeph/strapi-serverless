#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { StrapiServerlessStack } from '../lib/infrastructure-stack';
import { config } from '../lib/config';

const app = new App();
new StrapiServerlessStack(app, 'StrapiServerlessStack', config);
