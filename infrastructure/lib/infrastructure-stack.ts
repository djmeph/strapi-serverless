import { CfnOutput, Stack } from 'aws-cdk-lib';
import { BlockDeviceVolume, EbsDeviceVolumeType, GenericLinuxImage, Instance, InstanceType, IVpc, NatProvider, Peer, Port, SecurityGroup, SubnetType, UserData, Vpc } from 'aws-cdk-lib/aws-ec2';
import { AuroraMysqlEngineVersion, AuroraPostgresEngineVersion, DatabaseClusterEngine, ServerlessCluster } from 'aws-cdk-lib/aws-rds';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { InfrastructureStackProps } from './infrastructure-interface';

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
  instance: Instance;

  constructor(scope: Construct, id: string, private props: InfrastructureStackProps) {
    super(scope, id, props);
    this.createVPC();
    this.createBucket();
    this.createRdsDatabase();
    this.createEc2Instance();
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
  }

  createEc2Instance() {
    if (!this.props?.env?.region) return;

    const securityGroup = new SecurityGroup(this, 'Ec2SecurityGroup', {
      vpc: this.vpc,
    });
    securityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(22));
    securityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(80));
    securityGroup.addIngressRule(Peer.anyIpv6(), Port.tcp(80));
    securityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(443));
    securityGroup.addIngressRule(Peer.anyIpv6(), Port.tcp(443));
    securityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(1337));
    securityGroup.addIngressRule(Peer.anyIpv6(), Port.tcp(1337));

    const userData = UserData.forLinux();
    userData.addCommands(
      'apt update && apt upgrade',
      'curl -sL https://deb.nodesource.com/setup_14.x | bash -',
      'apt-get install -y nodejs build-essential python'
    );

    this.instance = new Instance(this, 'Ec2Instance', {
      instanceType: new InstanceType('t2.small'),
      machineImage: new GenericLinuxImage({
        [this.props.env.region]: 'ami-04505e74c0741db8d'
      }),
      vpc: this.vpc,
      vpcSubnets: {
        subnetType: SubnetType.PUBLIC
      },
      keyName: 'ponystream-dev',
      securityGroup,
      blockDevices: [{
        deviceName: '/dev/sda1',
        volume: BlockDeviceVolume.ebs(8, {
          volumeType: EbsDeviceVolumeType.GENERAL_PURPOSE_SSD
        })
      }],
      userData
    });
  }

  createOutputs() {
    new CfnOutput(this, 'Ec2PublicIp', {
      value: this.instance.instancePublicIp
    });

    new CfnOutput(this, 'CredsSecretArn', {
      value: this.db.secret?.secretArn || ''
    });

    new CfnOutput(this, 'BucketName', {
      value: this.bucket.bucketName
    })
  }
}
