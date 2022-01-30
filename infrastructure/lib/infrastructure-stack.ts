import { CfnOutput, Stack } from 'aws-cdk-lib';
import { Certificate, ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { InstanceType, IVpc, NatProvider, Peer, Port, SecurityGroup, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { AuroraMysqlEngineVersion, DatabaseClusterEngine, ServerlessCluster } from 'aws-cdk-lib/aws-rds';
import { HostedZone, IHostedZone } from 'aws-cdk-lib/aws-route53';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { InfrastructureStackProps } from './infrastructure-interface';
import * as path from 'path';
import { ApplicationLoadBalancedFargateService } from 'aws-cdk-lib/aws-ecs-patterns';
import { DockerImageAsset } from 'aws-cdk-lib/aws-ecr-assets';
import { ContainerImage, LogDrivers } from 'aws-cdk-lib/aws-ecs';
import { ApplicationProtocol, SslPolicy } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { ISecret, Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { ManagedPolicy } from 'aws-cdk-lib/aws-iam';

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
  bucket: Bucket;
  db: ServerlessCluster;
  certificate: ICertificate;
  domainZone: IHostedZone;
  apiLogGroup: LogGroup;
  jwtSecret: Secret;
  creds: ISecret;

  constructor(scope: Construct, id: string, private props: InfrastructureStackProps) {
    super(scope, id, props);
    this.createVPC();
    this.createSecrets();
    this.createBucket();
    this.createRdsDatabase();
    this.createCertificate();
    this.createHostedZone();
    this.createLogGroup();
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
  }

  createBucket() {
    this.bucket = new Bucket(this, 'Bucket');
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

  createLogGroup() {
    this.apiLogGroup = new LogGroup(this, 'ApiLogGroup', {
      logGroupName: this.props.logGroupName
    });
  }

  createFargateService() {
    if (!this.props.env.region) return ;

    const imageAsset = new DockerImageAsset(this, 'DockerImageAsset', {
      directory: path.join(__dirname, '../..', 'backend/docker'),
      buildArgs: {
        strapiUrl: `https://${this.props.subdomain}.${this.props.domainName}`,
        publicAdminUrl: `https://${this.props.subdomain}.${this.props.domainName}/admin`
      }
    });

    const fargateService = new ApplicationLoadBalancedFargateService(this, 'LoadBalancedFargateService', {
      desiredCount: 1,
      cpu: 512,
      memoryLimitMiB: 2048,
      taskImageOptions: {
        image: ContainerImage.fromDockerImageAsset(imageAsset),
        environment: {
          NODE_ENV: 'production',
          JWT_SECRET_ARN: this.jwtSecret.secretArn,
          CREDS_SECRET_ARN: this.creds.secretArn,
          PORT: '80',
          AWS_REGION: this.props.env.region,
          AWS_BUCKET_NAME: this.bucket.bucketName,
        },
        logDriver: LogDrivers.awsLogs({
          streamPrefix: this.props.subdomain,
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
      domainName: `${this.props.subdomain}.${this.props.domainName}`,
      domainZone: this.domainZone
    });

    // this.creds.grantRead(fargateService.taskDefinition.taskRole);
    // this.jwtSecret.grantRead(fargateService.taskDefinition.taskRole);
    // this.bucket.grantReadWrite(fargateService.taskDefinition.taskRole);

    fargateService.taskDefinition.taskRole.addManagedPolicy(
      ManagedPolicy.fromManagedPolicyArn(this, 'AmazonS3FullAccess', 'arn:aws:iam::aws:policy/AmazonS3FullAccess')
    );
    fargateService.taskDefinition.taskRole.addManagedPolicy(
      ManagedPolicy.fromManagedPolicyArn(this, 'SecretsManagerReadWrite', 'arn:aws:iam::aws:policy/SecretsManagerReadWrite')
    );
  }

  createOutputs() {
    new CfnOutput(this, 'CredsSecretArn', {
      value: this.db.secret?.secretArn || ''
    });

    new CfnOutput(this, 'BucketName', {
      value: this.bucket.bucketName
    })
  }
}
