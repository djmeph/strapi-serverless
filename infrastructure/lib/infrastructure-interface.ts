import { Environment, StackProps } from 'aws-cdk-lib/core'

/**
 * Create a file named config.ts and export a default value
 * with this interface as the type
 */
export interface InfrastructureStackProps extends StackProps {
  env: Environment;
  domainName: string;
  elbSubdomain: string;
  certificateArn: string;
}

/*
config.ts example

import { InfrastructureStackProps } from "./infrastructure-interface";

export const config: InfrastructureStackProps = {
  env: {
    region: 'us-east-1',
    account: '000000000000',
  },
  domainName: 'example.com',
  elbSubdomain: 'strapi',
  certificateArn: 'arn:aws:acm:us-east-1:000000000000:certificate/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
};

*/
