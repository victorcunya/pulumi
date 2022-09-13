const pulumi = require("@pulumi/pulumi");
const aws = require("@pulumi/aws");
const endpoints = require('./localstack-endpoints.json');
require('dotenv').config();

const PATH = "mypath"
const STAGE = process.env.STAGE
const REGION = process.env.REGION

const project = pulumi.getProject();

////////////////////////
// Create AWS Provider
////////////////////////

let awsProvider;

// Create the aws provider depending the stage of deployment
if (STAGE == "prod") {
    awsProvider = new aws.Provider("aws", { region: REGION });
} else {
    awsProvider = new aws.Provider("localstack", {
        skipCredentialsValidation: true,
        skipMetadataApiCheck: true,
        s3UsePathStyle: true,
        skipRequestingAccountId: true,
        accessKey: "mockAccessKey",
        secretKey: "mockSecretKey",
        region: REGION,
        skipRegionValidation: true,
        skipGetEc2Platforms: true,
        endpoints: [{
            apigateway: endpoints.APIGateway,
            cloudformation: endpoints.CloudFormation,
            cloudwatch: endpoints.CloudWatch,
            cloudwatchlogs: endpoints.CloudWatchLogs,
            dynamodb: endpoints.DynamoDB,
            es: endpoints.ES,
            firehose: endpoints.Firehose,
            iam: endpoints.IAM,
            kinesis: endpoints.Kinesis,
            kms: endpoints.KMS,
            lambda: endpoints.Lambda,
            route53: endpoints.Route53,
            redshift: endpoints.Redshift,
            s3: endpoints.S3,
            ses: endpoints.SES,
            sns: endpoints.SNS,
            sqs: endpoints.SQS,
            ssm: endpoints.SSM,
            sts: endpoints.STS,
        }],
    })
}

//////////////////////////
// Define policy
//////////////////////////
const policy = {
    Version: "2012-10-17",
    Statement: [
        {
            Action: "sts:AssumeRole",
            Principal: {
                Service: "lambda.amazonaws.com",
            },
            Effect: "Allow",
            Resource: "*",
        },
    ],
};

////////////////////
// Create IAM Role
////////////////////
// Todo:    Use localstack IAM once time format bug gets fixed
//          Issue: https://github.com/localstack/localstack/issues/1208
const role = new aws.iam.Role(
    `${project}-role`,
    {
        assumeRolePolicy: JSON.stringify(policy)
    },
    { provider: awsProvider, }
);


//////////////////
// Create Lambda
//////////////////

const lambdaNode = new aws.lambda.Function(
    `${project}-lambda-node`,
    {
        publish: true,
        runtime: aws.lambda.Runtime.NodeJS16dX,
        code: new pulumi.asset.AssetArchive({
            '.': new pulumi.asset.FileArchive('./node/')
        }),
        timeout: 5,
        handler: "handler.handler",
        role: role.arn,
        name: `${project}-lambda-node`
    },
    {
        provider: awsProvider,
        // dependsOn: fullAccess,
    }
);


//////////////////////
// Create APIGATEWAY
//////////////////////

const apiName = `${project}-api`;
const restApi = new aws.apigateway.RestApi(
    apiName,
    {
        name: apiName
    },
    { provider: awsProvider, }
);

////////////////////////////
// Create RestApi Resource
////////////////////////////

const resource = new aws.apigateway.Resource(
    `${project}-api-resource`,
    {
        parentId: restApi.rootResourceId,
        pathPart: PATH,
        restApi: restApi.id,
    },
    { provider: awsProvider, }
);

//////////////////////////
// Create RestAPI Method
//////////////////////////
const method = new aws.apigateway.Method(
    `${project}-api-method`,
    {
        restApi: restApi.id,
        resourceId: resource.id,
        httpMethod: "ANY",
        authorization: "NONE",
    },
    { provider: awsProvider, }
);

///////////////////////////////////
// Set RestApi Lambda Integration
///////////////////////////////////
const integration = new aws.apigateway.Integration(
    `${project}-api-integration`,
    {
        restApi: restApi.id,
        resourceId: resource.id,
        httpMethod: "ANY",
        type: "AWS_PROXY",
        integrationHttpMethod: "POST",
        passthroughBehavior: "WHEN_NO_MATCH",
        uri: lambdaNode.arn.apply(
            arn => arn && `arn:aws:apigateway:${REGION}:lambda:path/2015-03-31/functions/${arn}/invocations`
        ),
    },
    {
        dependsOn: [method],
        provider: awsProvider,
    }
);

///////////////////
// Deploy RestApi
///////////////////
const deployment = new aws.apigateway.Deployment(
    `${project}-api-deployment`,
    {
        restApi: restApi.id,
        description: `${project} deployment`,
        stageName: STAGE,
    },
    {
        dependsOn: [integration],
        provider: awsProvider,
    }
);

////////////////////////////////////////
// Create Lambda APIGATEWAY Permission
////////////////////////////////////////

// Note: Lambda permission is only required when deploying to AWS cloud
if (STAGE == "prod") {
    // Give permissions from API Gateway to invoke the Lambda
    let invokePermission = new aws.lambda.Permission(
        `${project}-api-lambda-permission`,
        {
            action: "lambda:invokeFunction",
            function: lambdaNode,
            principal: "apigateway.amazonaws.com",
            sourceArn: deployment.executionArn.apply(arn => arn + "*/*"),
        },
        { provider: awsProvider, }
    );
}

//////////////////////////////////
// Export RestApi https endpoint
//////////////////////////////////

let endpoint;

if (STAGE == "prod") {
    endpoint = deployment.invokeUrl.apply(url => url + `/ ${PATH}`);
} else {
    endpoint = restApi.id
        .promise()
        .then(
            () => restApi.id.apply(
                id => `http://localhost:4566/restapis/${id}/${STAGE}/_user_request_/${PATH}`
            )
        );
}

exports.endpoint = endpoint;


