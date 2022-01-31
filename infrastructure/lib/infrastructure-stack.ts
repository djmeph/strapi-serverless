import { Duration, Fn, Stack } from 'aws-cdk-lib';
import { Certificate, ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { InstanceType, IVpc, NatProvider, Peer, Port, SecurityGroup, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { AuroraMysqlEngineVersion, DatabaseClusterEngine, ServerlessCluster } from 'aws-cdk-lib/aws-rds';
import { ARecord, CnameRecord, HostedZone, IHostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { InfrastructureStackProps } from './infrastructure-interface';
import { ISecret, Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Code, DockerImageCode, DockerImageFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { LambdaRestApi } from 'aws-cdk-lib/aws-apigateway';
import { ApiGateway } from 'aws-cdk-lib/aws-route53-targets';
import { CloudFrontAllowedMethods, CloudFrontWebDistribution, LambdaEdgeEventType, OriginAccessIdentity, OriginProtocolPolicy, ViewerProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { experimental } from 'aws-cdk-lib/aws-cloudfront';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import * as path from 'path';

const cidrBlocks = {
  vpcCidr: '10.11.0.0/16',
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
  webBucket: Bucket;
  oai: OriginAccessIdentity;
  db: ServerlessCluster;
  certificate: ICertificate;
  domainZone: IHostedZone;
  jwtSecret: Secret;
  dbCreds: ISecret;
  func: DockerImageFunction;
  api: LambdaRestApi;
  cachedFunc: DockerImageFunction;
  cachedApi: LambdaRestApi;
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
    this.assetsBucket = new Bucket(this, 'AssetsBucket');
    this.webBucket = new Bucket(this, 'WebBucket');
    this.oai = new OriginAccessIdentity(this, 'OAI');
    this.webBucket.grantReadWrite(this.oai);
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
      this.dbCreds = this.db.secret;
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
        CREDS_SECRET_ARN: this.dbCreds.secretArn,
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

    const s3PolicyStatement = new PolicyStatement({
      actions: [
        's3:PutObject',
        's3:GetObjectAcl',
        's3:GetObject',
        's3:AbortMultipartUpload',
        's3:ListBucket',
        's3:DeleteObject',
        's3:PutObjectAcl',
        's3:GetObjectAcl',
        's3:PutObjectAcl'
      ],
      effect: Effect.ALLOW,
      resources: [
        this.assetsBucket.bucketArn,
        Fn.join('/', [this.assetsBucket.bucketArn, '*'])
      ],
    });

    const secretsPolicyStatement = new PolicyStatement({
      actions: [
        'secretsmanager:DescribeSecret',
        'secretsmanager:GetSecretValue',
        'secretsmanager:ListSecretVersionIds'
      ],
      effect: Effect.ALLOW,
      resources: [
        this.dbCreds.secretArn,
        this.jwtSecret.secretArn
      ],
    });

    this.func.role?.addToPrincipalPolicy(secretsPolicyStatement);
    this.func.role?.addToPrincipalPolicy(s3PolicyStatement);

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

    this.distribution = new CloudFrontWebDistribution(this, 'WebDistribution', {
        originConfigs: [
          {
            s3OriginSource: {
              s3BucketSource: this.webBucket,
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
          {
            customOriginSource: {
              domainName: `${this.props.subdomain}-api.${this.props.domainName}`,
              originProtocolPolicy: OriginProtocolPolicy.HTTPS_ONLY
            },
            behaviors: [
              {
                allowedMethods: CloudFrontAllowedMethods.ALL,
                pathPattern: '/api/*',
              }
            ]
          }
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

    new CnameRecord(this, 'DistributionCNameRecord', {
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
      destinationBucket: this.webBucket,
      destinationKeyPrefix: 'strapi-admin',
      distribution: this.distribution,
      distributionPaths: ['/*'],
    });
  }
}
