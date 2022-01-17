import { CfnOutput, Fn, Stack } from 'aws-cdk-lib';
import { InstanceType, IVpc, NatProvider, Peer, Port, SecurityGroup, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { DockerImageAsset } from 'aws-cdk-lib/aws-ecr-assets';
import { ContainerImage, LogDrivers } from 'aws-cdk-lib/aws-ecs';
import { ApplicationLoadBalancedFargateService } from 'aws-cdk-lib/aws-ecs-patterns';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import {
  AuroraMysqlEngineVersion,
  DatabaseClusterEngine,
  ServerlessCluster
} from 'aws-cdk-lib/aws-rds';
import { Bucket, IBucket } from 'aws-cdk-lib/aws-s3';
import { ISecret, Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import * as path from 'path';
import { ApplicationProtocol, SslPolicy } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { InfrastructureStackProps } from './infrastructure-interface';
import { Certificate, ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { HostedZone, IHostedZone } from 'aws-cdk-lib/aws-route53';

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
  rdsCluster: ServerlessCluster;
  certificate: ICertificate;
  domainZone: IHostedZone;
  fargateService: ApplicationLoadBalancedFargateService;
  apiLogGroup: LogGroup;
  creds: ISecret;
  jwtSecret: ISecret;
  saltSecret: ISecret;
  adminAssetsBucket: IBucket;
  webAssetsBucket: IBucket;

  constructor(scope: Construct, id: string, private props: InfrastructureStackProps) {
    super(scope, id, props);
    this.createVPC();
    this.createSecrets();
    this.createBuckets();
    this.createRDSCluster();
    this.createLogGroup();
    this.createCertificate();
    this.createHostedZone();
    this.createFargateService();
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

    this.saltSecret = new Secret(this, 'SaltSecret', {
      secretName: 'strapi-salt-secret',
      description: 'Strapi Salt Secret'
    });
  }

  createBuckets() {
    this.adminAssetsBucket = new Bucket(this, 'AdminAssetsBucket');
    this.webAssetsBucket = new Bucket(this, 'WebAssetsBucket');
  }

  createRDSCluster() {
    const rdsSecurityGroup = new SecurityGroup(this, 'RDSSecurityGroup', {
      vpc: this.vpc,
      description: 'Ingress access to RDS'
    });

    for (const cidr of Object.values(cidrBlocks)) {
      rdsSecurityGroup.addIngressRule(
        Peer.ipv4(cidr),
        Port.allTcp()
      )
    }

    this.rdsCluster = new ServerlessCluster(this, 'RdsCluster', {
      engine: DatabaseClusterEngine.auroraMysql({
        version: AuroraMysqlEngineVersion.VER_5_7_12
      }),
      clusterIdentifier: 'strapi-serverless',
      defaultDatabaseName: 'strapi',
      vpc: this.vpc,
      vpcSubnets: {
        subnetType: SubnetType.PRIVATE_ISOLATED
      },
      securityGroups: [rdsSecurityGroup]
    });

    if (this.rdsCluster.secret) {
      this.creds = this.rdsCluster.secret;
    }
  }

  createLogGroup() {
    this.apiLogGroup = new LogGroup(this, 'ApiLogGroup', {
      logGroupName: 'strapi-serverless'
    });
  }

  createCertificate() {
    this.certificate = Certificate.fromCertificateArn(
      this,
      'SSLCertificate',
      this.props.certificateArn
    );
  }

  createHostedZone() {
    this.domainZone = HostedZone.fromLookup(this, 'HostedZone', {
      domainName: this.props.domainName
    });
  }

  createFargateService() {
    const imageAsset = new DockerImageAsset(this, 'DockerImageAsset', {
      directory: path.join(__dirname, '../..', 'backend/docker'),
    });

    this.fargateService = new ApplicationLoadBalancedFargateService(this, 'LoadBalancedFargateService', {
      desiredCount: 1,
      cpu: 512,
      memoryLimitMiB: 4096,
      taskImageOptions: {
        image: ContainerImage.fromDockerImageAsset(imageAsset),
        environment: {
          NODE_ENV: 'production',
          JWT_SECRET_ARN: this.jwtSecret.secretArn,
          SALT_SECRET_ARN: this.saltSecret.secretArn,
          CREDS_SECRET_ARN: this.creds.secretArn,
          ASSETS_BUCKET: this.webAssetsBucket.bucketName,
          PORT: '80',
          STRAPI_URL: `https://${this.props.elbSubdomain}.${this.props.domainName}`,
          PUBLIC_ADMIN_URL: `https://${this.props.elbSubdomain}.${this.props.domainName}/admin`,
          SERVE_ADMIN: 'false'
        },
        logDriver: LogDrivers.awsLogs({
          streamPrefix: 'strapi-serverless',
          logGroup: this.apiLogGroup,
        }),
        enableLogging: true
      },
      publicLoadBalancer: true,
      vpc: this.vpc,
      sslPolicy: SslPolicy.RECOMMENDED,
      redirectHTTP: true,
      protocol: ApplicationProtocol.HTTPS,
      certificate: this.certificate,
      domainName: `${this.props.elbSubdomain}.${this.props.domainName}`,
      domainZone: this.domainZone,
    });

    this.creds.grantRead(this.fargateService.taskDefinition.taskRole);
    this.jwtSecret.grantRead(this.fargateService.taskDefinition.taskRole);
    this.saltSecret.grantRead(this.fargateService.taskDefinition.taskRole);
    this.webAssetsBucket.grantRead(this.fargateService.taskDefinition.taskRole);
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
    });

    new CfnOutput(this, 'ApiUrl', {
      value: this.fargateService.loadBalancer.loadBalancerDnsName,
      exportName: Fn.join(':', [
        Fn.ref('AWS::StackName'),
        'api-url',
      ]),
      description: 'API URL',
    });
  }
}
