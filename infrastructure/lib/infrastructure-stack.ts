import { CfnOutput, Fn, Stack, StackProps } from 'aws-cdk-lib';
import { InstanceType, IVpc, NatProvider, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import {
  AuroraMysqlEngineVersion,
  DatabaseClusterEngine,
  ServerlessCluster
} from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';

const cidrBlocks = {
  vpcCidr: '10.1.0.0/16',
  publicSubnetACidr: '10.11.0.0/20',
  publicSubnetBCidr: '10.11.16.0/20',
  privateSubnetACidr: '10.11.32.0/20',
  privateSubnetBCidr: '10.11.48.0/20',
  isolatedSubnetACidr: '10.11.64.0/20',
  isolatedSubnetBCidr: '10.11.80.0/20',
};

export class StrapiServerlessStack extends Stack {
  vpc: IVpc;
  cluster: ServerlessCluster

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    this.createVPC();
    this.createRDSCluster();
    this.createOutputs();
  }

  createVPC() {
    this.vpc = new Vpc(this, 'VPC', {
      maxAzs: 2,
      cidr: cidrBlocks.vpcCidr,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: SubnetType.PUBLIC,
          cidrMask: 20,
        },
        {
          name: 'private',
          subnetType: SubnetType.PRIVATE_WITH_NAT,
          cidrMask: 20,
        },
        {
          name: 'isolated',
          subnetType: SubnetType.PRIVATE_ISOLATED,
          cidrMask: 20,
        },
      ],
      natGatewayProvider: NatProvider.instance({
        instanceType: new InstanceType('t3.nano')
      }),
      natGateways: 1
    });
  }

  createRDSCluster() {
    this.cluster = new ServerlessCluster(this, 'RdsCluster', {
      engine: DatabaseClusterEngine.auroraMysql({
        version: AuroraMysqlEngineVersion.VER_5_7_12
      }),
      clusterIdentifier: 'strapi-serverless',
      defaultDatabaseName: 'strapi',
      vpc: this.vpc,
      vpcSubnets: {
        subnetType: SubnetType.PRIVATE_ISOLATED
      },
    });
  }

  createOutputs() {
    if (this.cluster.secret) {
      new CfnOutput(this, 'RdsCredentialsSecretArn', {
        value: this.cluster.secret.secretArn,
        exportName: Fn.join(':', [
          Fn.ref('AWS::StackName'),
          'rds-credentials-secret-arn',
        ]),
        description: 'RDS Credentials Secret ARN',
      });
    }
  }
}
