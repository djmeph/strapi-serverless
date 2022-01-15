import { CfnOutput, Duration, Fn, Stack, StackProps } from 'aws-cdk-lib';
import { InstanceType, IVpc, NatProvider, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Code, Function, Runtime } from 'aws-cdk-lib/aws-lambda';
import {
  AuroraMysqlEngineVersion,
  DatabaseClusterEngine,
  ServerlessCluster
} from 'aws-cdk-lib/aws-rds';
import { Bucket, IBucket } from 'aws-cdk-lib/aws-s3';
import { ISecret, Secret } from 'aws-cdk-lib/aws-secretsmanager';
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
  cluster: ServerlessCluster;
  creds: ISecret;
  jwtSecret: ISecret;
  adminAssetsBucket: IBucket;
  webAssetsBucket: IBucket;
  lambdaApi: Function;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    this.createVPC();
    this.createSecrets();
    this.createBuckets();
    this.createRDSCluster();
    this.createLambdaAPI();
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

  createSecrets() {
    this.jwtSecret = new Secret(this, 'JwtSecret', {
      secretName: 'strapi-jwt-secret',
      description: 'Strapi JWT Secret'
    });
  }

  createBuckets() {
    this.adminAssetsBucket = new Bucket(this, 'AdminAssetsBucket');
    this.webAssetsBucket = new Bucket(this, 'WebAssetsBucket');
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
    if (this.cluster.secret) {
      this.creds = this.cluster.secret;
    }
  }

  createLambdaAPI() {
    this.lambdaApi = new Function(this, 'LambdaApi', {
      code: Code.fromAsset(`${__dirname}/../../backend/build`),
      handler: 'index.handler',
      timeout: Duration.seconds(30),
      runtime: Runtime.NODEJS_14_X,
      memorySize: 1024,
      vpc: this.vpc,
      vpcSubnets: {
        subnetType: SubnetType.PRIVATE_WITH_NAT
      },
      environment: {
        NODE_ENV: 'production',
        JWT_SECRET_ARN: this.jwtSecret.secretArn,
        CREDS_SECRET_ARN: this.creds.secretArn,
        ASSETS_BUCKET: this.webAssetsBucket.bucketName
      }
    });
  }

  createOutputs() {
    new CfnOutput(this, 'RdsCredentialsSecretArn', {
      value: this.creds.secretArn,
      exportName: Fn.join(':', [
        Fn.ref('AWS::StackName'),
        'rds-credentials-secret-arn',
      ]),
      description: 'RDS Credentials Secret ARN',
    });

    new CfnOutput(this, 'JwtSecretArn', {
      value: this.jwtSecret.secretArn,
      exportName: Fn.join(':', [
        Fn.ref('AWS::StackName'),
        'jwt-secret-arn',
      ]),
      description: 'JWT Secret ARN',
    })
  }
}
