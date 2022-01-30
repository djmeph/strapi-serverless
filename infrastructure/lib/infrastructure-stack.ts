import { CfnOutput, Duration, Stack } from 'aws-cdk-lib';
import { Certificate, ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { InstanceType, IVpc, NatProvider, Peer, Port, SecurityGroup, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { AuroraMysqlEngineVersion, DatabaseClusterEngine, ServerlessCluster } from 'aws-cdk-lib/aws-rds';
import { ARecord, CnameRecord, HostedZone, IHostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { InfrastructureStackProps } from './infrastructure-interface';
import * as path from 'path';
import { ISecret, Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { ManagedPolicy } from 'aws-cdk-lib/aws-iam';
import { Code, DockerImageCode, DockerImageFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { LambdaRestApi } from 'aws-cdk-lib/aws-apigateway';
import { ApiGateway } from 'aws-cdk-lib/aws-route53-targets';
import { CloudFrontWebDistribution, LambdaEdgeEventType, OriginAccessIdentity, ViewerProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { experimental } from 'aws-cdk-lib/aws-cloudfront';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';

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
  assetsBucket: Bucket;
  adminBucket: Bucket;
  oai: OriginAccessIdentity;
  db: ServerlessCluster;
  certificate: ICertificate;
  domainZone: IHostedZone;
  apiLogGroup: LogGroup;
  jwtSecret: Secret;
  creds: ISecret;
  func: DockerImageFunction;
  api: LambdaRestApi;
  distribution: CloudFrontWebDistribution;

  constructor(scope: Construct, id: string, private props: InfrastructureStackProps) {
    super(scope, id, props);
    this.createVPC();
    this.createSecrets();
    this.createBucket();
    this.createRdsDatabase();
    this.createCertificate();
    this.createHostedZone();
    this.createLambdaFunction();
    this.createDistribution();
    this.deployAdminWebAssets();
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

  createBucket() {
    this.assetsBucket = new Bucket(this, 'Bucket');
    this.adminBucket = new Bucket(this, 'AdminBucket');
    this.oai = new OriginAccessIdentity(this, 'OAI');
    this.adminBucket.grantReadWrite(this.oai);
  }

  createRdsDatabase() {
    const rdsSecurityGroup = new SecurityGroup(this, 'RDSSecurityGroup', {
      vpc: this.vpc,
      description: 'Ingress access to RDS'
    });

    for (const cidr of Object.values(cidrBlocks)) {
      rdsSecurityGroup.addIngressRule(
        Peer.ipv4(cidr),
        Port.tcp(3306)
      )
    }

    this.db = new ServerlessCluster(this, 'RdsCluster', {
      engine: DatabaseClusterEngine.auroraMysql({
        version: AuroraMysqlEngineVersion.VER_5_7_12
      }),
      defaultDatabaseName: 'strapi',
      vpc: this.vpc,
      vpcSubnets: {
        subnetType: SubnetType.PRIVATE_ISOLATED
      },
      securityGroups: [rdsSecurityGroup]
    });

    if (this.db.secret) {
      this.creds = this.db.secret;
    }
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

  createLambdaFunction() {
    if (!this.props.env.region) return;

    const code = DockerImageCode.fromImageAsset(path.join(__dirname, '../..', 'backend/docker'));

    this.func = new DockerImageFunction(this, 'LambdaFunction', {
      code,
      timeout: Duration.seconds(30),
      memorySize: 2048,
      environment: {
        NODE_ENV: 'production',
        JWT_SECRET_ARN: this.jwtSecret.secretArn,
        CREDS_SECRET_ARN: this.creds.secretArn,
        AWS_BUCKET_NAME: this.assetsBucket.bucketName,
        STRAPI_URL: `https://${this.props.subdomain}-api.${this.props.domainName}`,
        STRAPI_ADMIN_URL: `https://${this.props.subdomain}.${this.props.domainName}`,
        SERVE_ADMIN: 'false',
      },
      vpc: this.vpc,
      vpcSubnets: {
        subnetType: SubnetType.PRIVATE_WITH_NAT,
      },
    });

    this.func.role?.addManagedPolicy(
      ManagedPolicy.fromManagedPolicyArn(this, 'AmazonS3FullAccess', 'arn:aws:iam::aws:policy/AmazonS3FullAccess')
    );
    this.func.role?.addManagedPolicy(
      ManagedPolicy.fromManagedPolicyArn(this, 'SecretsManagerReadWrite', 'arn:aws:iam::aws:policy/SecretsManagerReadWrite')
    );

    this.api = new LambdaRestApi(this, 'LambdaRestApi', {
      handler: this.func,
      binaryMediaTypes: ['multipart/form-data'],
      domainName: {
        certificate: this.certificate,
        domainName: `${this.props.subdomain}-api.${this.props.domainName}`,
      },
    });

    new ARecord(this, 'ApiDNSRecord', {
      target: RecordTarget.fromAlias(new ApiGateway(this.api)),
      zone: this.domainZone,
      recordName: `${this.props.subdomain}-api`
    });
  }

  createDistribution() {
    const lambdaFunction = new experimental.EdgeFunction(this, 'EdgeFunctionOriginResponse', {
      code: Code.fromAsset(path.join(__dirname, '..', 'lambdas/origin-response')),
      runtime: Runtime.NODEJS_14_X,
      handler: 'index.handler',
    });

    this.distribution = new CloudFrontWebDistribution(
      this,
      'WebDistribution',
      {
        originConfigs: [
          {
            s3OriginSource: {
              s3BucketSource: this.adminBucket,
              originHeaders: {
                'X-Api-Uri': `https://${this.props.subdomain}-api.${this.props.domainName}`,
              },
              originAccessIdentity: this.oai,
              originPath: '/strapi-admin',
            },
            behaviors: [
              {
                isDefaultBehavior: true,
                lambdaFunctionAssociations: [
                  {
                    eventType: LambdaEdgeEventType.ORIGIN_RESPONSE,
                    lambdaFunction,
                  },
                ],
              },
            ],
          },
        ],
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        viewerCertificate: {
          aliases: [`${this.props.subdomain}.${this.props.domainName}`],
          props: {
            acmCertificateArn: this.certificate.certificateArn,
            sslSupportMethod: 'sni-only',
          },
        },
        errorConfigurations: [
          {
            errorCode: 404,
            responseCode: 200,
            responsePagePath: '/index.html',
            errorCachingMinTtl: 300,
          },
          {
            errorCode: 403,
            responseCode: 200,
            responsePagePath: '/index.html',
            errorCachingMinTtl: 300,
          },
        ],
      }
    );

    new CnameRecord(this, 'AdminCNameRecord', {
      zone: this.domainZone,
      domainName: this.distribution.distributionDomainName,
      recordName: this.props.subdomain,
    });
  }

  deployAdminWebAssets() {
    new BucketDeployment(this, 'DeployAdminWebAssets', {
      sources: [
        Source.asset(path.join(__dirname, '../..', 'backend/build')
        ),
      ],
      destinationBucket: this.adminBucket,
      destinationKeyPrefix: 'strapi-admin',
      distribution: this.distribution,
      distributionPaths: ['/*'],
    });
  }

  createOutputs() {
    new CfnOutput(this, 'CredsSecretArn', {
      value: this.db.secret?.secretArn || ''
    });

    new CfnOutput(this, 'BucketName', {
      value: this.assetsBucket.bucketName
    })
  }
}
