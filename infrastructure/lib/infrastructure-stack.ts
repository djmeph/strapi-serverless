import { Duration, Fn, Stack } from 'aws-cdk-lib';
import { InstanceType, IVpc, NatProvider, Peer, Port, SecurityGroup, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import {
  AuroraMysqlEngineVersion,
  DatabaseClusterEngine,
  ServerlessCluster
} from 'aws-cdk-lib/aws-rds';
import { Bucket, IBucket } from 'aws-cdk-lib/aws-s3';
import { ISecret, Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import * as path from 'path';
import { InfrastructureStackProps } from './infrastructure-interface';
import { Certificate, ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { ARecord, CnameRecord, HostedZone, IHostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { CloudFrontWebDistribution, LambdaEdgeEventType, OriginAccessIdentity, ViewerProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { Code, DockerImageCode, DockerImageFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { BasePathMapping, DomainName, LambdaRestApi } from 'aws-cdk-lib/aws-apigateway';
import { experimental } from 'aws-cdk-lib/aws-cloudfront';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { ApiGateway } from 'aws-cdk-lib/aws-route53-targets';

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
  creds: ISecret;
  jwtSecret: ISecret;
  strapiAssetBucket: IBucket;
  webAssetBucket: IBucket;
  oai: OriginAccessIdentity;
  func: DockerImageFunction;
  dist: CloudFrontWebDistribution;

  constructor(scope: Construct, id: string, private props: InfrastructureStackProps) {
    super(scope, id, props);
    this.createVPC();
    this.createSecrets();
    this.createBuckets();
    this.createRDSCluster();
    this.createCertificate();
    this.createHostedZone();
    this.createLambdaFunction();
    this.createRestApi();
    this.createCloudfrontDistribution();
    this.deployWebAssets();
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
    this.strapiAssetBucket = new Bucket(this, 'StrapiAssetBucket');
    this.webAssetBucket = new Bucket(this, 'WebAssetBucket');
    this.oai = new OriginAccessIdentity(this, 'CloudfrontOriginAccessIdentity');
    this.strapiAssetBucket.grantRead(this.oai);
    this.webAssetBucket.grantRead(this.oai);
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
    const directory = path.join(__dirname, '../..', 'backend/docker');

    const code = DockerImageCode.fromImageAsset(directory);

    this.func = new DockerImageFunction(this, 'LambdaApi', {
      code,
      timeout: Duration.seconds(30),
      memorySize: 4096,
      environment: {
        NODE_ENV: 'production',
        JWT_SECRET_ARN: this.jwtSecret.secretArn,
        CREDS_SECRET_ARN: this.creds.secretArn,
        ASSETS_BUCKET: this.strapiAssetBucket.bucketName,
        PORT: '80',
        STRAPI_URL: `https://${this.props.apiSubdomain}.${this.props.domainName}`,
        DOMAIN_NAME: this.props.domainName
      },
      vpc: this.vpc,
      vpcSubnets: {
        subnetType: SubnetType.PRIVATE_WITH_NAT,
      },
    });

    this.creds.grantRead(this.func);
    this.jwtSecret.grantRead(this.func);
    this.strapiAssetBucket.grantReadWrite(this.func);
  }

  private createRestApi() {
    const api = new LambdaRestApi(this, 'RestApi', {
      handler: this.func,
      binaryMediaTypes: ['multipart/form-data'],
      domainName: {
        domainName: `${this.props.apiSubdomain}.${this.props.domainName}`,
        certificate: this.certificate,
      }
    });

    new ARecord(this, 'ARecord', {
      zone: this.domainZone,
      target: RecordTarget.fromAlias(new ApiGateway(api)),
      recordName: this.props.apiSubdomain
    });
  }

  createCloudfrontDistribution() {
    const edgeLambdaOriginResponse = new experimental.EdgeFunction(this, 'EdgeFunctionOriginResponse',
      {
        code: Code.fromAsset(path.join(__dirname, '..', 'lambdas/origin-response')),
        runtime: Runtime.NODEJS_14_X,
        handler: 'index.handler',
        description: 'Origin Response Edge Lambda for Strapi UI',
      },
    );

    this.dist = new CloudFrontWebDistribution(this, 'CloudFrontWebDistribution', {
      originConfigs: [{
        s3OriginSource: {
          s3BucketSource: this.webAssetBucket,
          originHeaders: {
            'X-api-uri': `https://${this.props.apiSubdomain}.${this.props.domainName}`
          },
          originAccessIdentity: this.oai,
        },
        behaviors: [{
          isDefaultBehavior: true,
          lambdaFunctionAssociations: [{
            eventType: LambdaEdgeEventType.ORIGIN_RESPONSE,
            lambdaFunction: edgeLambdaOriginResponse,
          }]
        }]
      }],
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      viewerCertificate: {
        aliases: [`${this.props.subdomain}.${this.props.domainName}`],
        props: {
          acmCertificateArn: this.certificate.certificateArn,
          sslSupportMethod: 'sni-only',
        }
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
        }
      ],
    });

    new CnameRecord(this, 'CloudfrontCnameRecord', {
      domainName: this.dist.distributionDomainName,
      zone: this.domainZone,
      recordName: this.props.subdomain,
    });
  }

  deployWebAssets() {
    new BucketDeployment(this, 'DeployAdminAssets', {
      sources: [
        Source.asset(
          path.join(__dirname, '../..', 'backend/build')
        ),
      ],
      destinationBucket: this.webAssetBucket,
      distribution: this.dist,
      distributionPaths: ['/*'],
    });
  }
}
