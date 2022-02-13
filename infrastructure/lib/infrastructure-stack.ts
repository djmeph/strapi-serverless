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
import { DockerImageCode, DockerImageFunction } from 'aws-cdk-lib/aws-lambda';
import { LambdaRestApi } from 'aws-cdk-lib/aws-apigateway';
import { ApiGateway } from 'aws-cdk-lib/aws-route53-targets';
import { AllowedMethods, CachedMethods, CachePolicy, Distribution, IDistribution, OriginAccessIdentity } from 'aws-cdk-lib/aws-cloudfront';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { S3Origin } from 'aws-cdk-lib/aws-cloudfront-origins';
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
  distribution: IDistribution;
  adminDistribution: IDistribution;

  constructor(scope: Construct, id: string, private props: InfrastructureStackProps) {
    super(scope, id, props);
    this.createVPC();
    this.createSecrets();
    this.createBuckets();
    this.createRdsDatabase();
    this.createCertificate();
    this.createHostedZone();
    this.createLambdaFunction();
    this.createDistributions();
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

  createBuckets() {
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
    if (!this.props.env.region) throw Error('Region missing from config');

    const func = new DockerImageFunction(this, 'LambdaFunction', {
      code: DockerImageCode.fromImageAsset(
        path.join(__dirname, '../..', 'backend/docker')
      ),
      timeout: Duration.seconds(30),
      memorySize: 2048,
      environment: {
        NODE_ENV: 'production',
        JWT_SECRET_ARN: this.jwtSecret.secretArn,
        CREDS_SECRET_ARN: this.dbCreds.secretArn,
        AWS_BUCKET_NAME: this.assetsBucket.bucketName,
        STRAPI_URL: `https://${this.props.subdomain}-api.${this.props.domainName}`,
        STRAPI_ADMIN_URL: `https://${this.props.subdomain}-admin.${this.props.domainName}`,
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

    func.role?.addToPrincipalPolicy(secretsPolicyStatement);
    func.role?.addToPrincipalPolicy(s3PolicyStatement);

    const api = new LambdaRestApi(this, 'LambdaRestApi', {
      handler: func,
      binaryMediaTypes: ['multipart/form-data'],
      domainName: {
        certificate: this.certificate,
        domainName: `${this.props.subdomain}-api.${this.props.domainName}`,
      },
    });

    new ARecord(this, 'ApiDNSRecord', {
      target: RecordTarget.fromAlias(new ApiGateway(api)),
      zone: this.domainZone,
      recordName: `${this.props.subdomain}-api`
    });

    const cachedApi = new LambdaRestApi(this, 'CachedLambdaRestApi', {
      handler: func,
      binaryMediaTypes: ['multipart/form-data'],
      domainName: {
        certificate: this.certificate,
        domainName: `${this.props.subdomain}-cached.${this.props.domainName}`,
      },
      deployOptions: {
        methodOptions: {
          '/*/*': {
            cachingEnabled: true,
            cacheTtl: Duration.hours(1),
          }
        }
      }
    });

    new ARecord(this, 'CachedApiDNSRecord', {
      target: RecordTarget.fromAlias(new ApiGateway(cachedApi)),
      zone: this.domainZone,
      recordName: `${this.props.subdomain}-cached`
    });
  }

  createDistributions() {
    this.distribution = new Distribution(this, 'WebDistribution', {
      defaultBehavior: {
        origin: new S3Origin(this.webBucket, {
          originPath: '/nextjs-web',
          originAccessIdentity: this.oai
        }),
        allowedMethods: AllowedMethods.ALLOW_ALL,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        cachedMethods: CachedMethods.CACHE_GET_HEAD_OPTIONS,
      },
      certificate: this.certificate,
      domainNames: [`${this.props.subdomain}.${this.props.domainName}`],
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html'
        },
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html'
        }
      ]
    });

    new CnameRecord(this, 'DistributionCNameRecord', {
      zone: this.domainZone,
      domainName: this.distribution.distributionDomainName,
      recordName: this.props.subdomain,
    });

    this.adminDistribution = new Distribution(this, 'AdminDistribution', {
      defaultBehavior: {
        origin: new S3Origin(this.webBucket, {
          originPath: '/strapi-admin',
          originAccessIdentity: this.oai
        }),
        allowedMethods: AllowedMethods.ALLOW_ALL,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        cachedMethods: CachedMethods.CACHE_GET_HEAD_OPTIONS,
      },
      certificate: this.certificate,
      domainNames: [`${this.props.subdomain}-admin.${this.props.domainName}`],
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html'
        },
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html'
        }
      ]
    });

    new CnameRecord(this, 'AdminDistributionCNameRecord', {
      zone: this.domainZone,
      domainName: this.adminDistribution.distributionDomainName,
      recordName: `${this.props.subdomain}-admin`,
    });
  }

  deployAdminWebAssets() {
    new BucketDeployment(this, 'DeployWebAssets', {
      sources: [
        Source.asset(path.join(__dirname, '../../', 'frontend/out'))
      ],
      destinationBucket: this.webBucket,
      destinationKeyPrefix: 'nextjs-web',
      distribution: this.distribution,
      distributionPaths: ['/*'],
    });

    new BucketDeployment(this, 'DeployAdminWebAssets', {
      sources: [
        Source.asset(path.join(__dirname, '../..', 'backend/build')),
      ],
      destinationBucket: this.webBucket,
      destinationKeyPrefix: 'strapi-admin',
      distribution: this.adminDistribution,
      distributionPaths: ['/*'],
    });
  }
}
