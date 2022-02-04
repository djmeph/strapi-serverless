import { exec } from 'child_process';
import { config } from '../infrastructure/lib/config';

const command = [
  'NODE_ENV=production',
  `STRAPI_URL=https://${config.subdomain}-api.${config.domainName}`,
  `STRAPI_ADMIN_URL=https://${config.subdomain}.${config.domainName}/admin`,
  'yarn build'
].join(' ');

const proc = exec(command);
proc.stdout.on('data', (data) => console.log(data));
proc.on('exit', (code) => process.exit(code));
