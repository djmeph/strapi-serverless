import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { StrapiServerlessStack }  from '../lib/infrastructure-stack';

test('SQS Queue and SNS Topic Created', () => {
  const app = new cdk.App();
  // WHEN
  const stack = new StrapiServerlessStack(app, 'MyTestStack');
  // THEN
  const template = Template.fromStack(stack);
});
