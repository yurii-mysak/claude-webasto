#!/bin/bash
# setup-secrets.sh: Interactive script to configure AWS Secrets Manager
# for storing the Claude Code OAuth token.

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}========================================"
echo "Claude Webasto - Secrets Setup"
echo -e "========================================${NC}"
echo ""

# Check AWS CLI
if ! command -v aws &> /dev/null; then
    echo -e "${RED}Error: AWS CLI not found${NC}"
    echo "Install from: https://aws.amazon.com/cli/"
    exit 1
fi

# Check AWS credentials
if ! aws sts get-caller-identity &> /dev/null; then
    echo -e "${RED}Error: AWS credentials not configured${NC}"
    echo "Run: aws configure"
    exit 1
fi

CALLER_IDENTITY=$(aws sts get-caller-identity --output text --query 'Account')
echo -e "${GREEN}✓ AWS CLI configured (Account: ${CALLER_IDENTITY})${NC}"
echo ""

# Prompt for region
read -p "AWS Region (default: eu-north-1): " AWS_REGION
AWS_REGION=${AWS_REGION:-eu-north-1}

SECRET_NAME="claude-webasto/prod/token"

echo ""
echo -e "${BLUE}Secret will be created as: ${SECRET_NAME}${NC}"
echo -e "${BLUE}Region: ${AWS_REGION}${NC}"
echo ""

# Explain how to get the token
echo -e "${YELLOW}To get your Claude Code OAuth token, run:${NC}"
echo ""
echo "    claude setup-token"
echo ""
echo "This will output a token you can paste below."
echo ""

# Prompt for OAuth token
read -sp "Claude Code OAuth Token: " OAUTH_TOKEN
echo ""

# Validate input
if [ -z "$OAUTH_TOKEN" ]; then
    echo -e "${RED}Error: OAuth token is required${NC}"
    exit 1
fi

# Create JSON payload safely
if command -v jq &> /dev/null; then
    SECRET_JSON=$(jq -n --arg token "$OAUTH_TOKEN" '{"CLAUDE_CODE_OAUTH_TOKEN": $token}')
else
    SECRET_JSON=$(python3 -c "import json,sys; print(json.dumps({'CLAUDE_CODE_OAUTH_TOKEN': sys.argv[1]}))" "$OAUTH_TOKEN")
fi

echo ""
echo -e "${YELLOW}Creating secret in AWS Secrets Manager...${NC}"
echo ""

# Check if secret already exists
if aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --region "$AWS_REGION" &> /dev/null; then
    echo -e "${YELLOW}Secret already exists. Updating...${NC}"

    aws secretsmanager update-secret \
        --secret-id "$SECRET_NAME" \
        --secret-string "$SECRET_JSON" \
        --region "$AWS_REGION"

    echo ""
    echo -e "${GREEN}✓ Secret updated successfully${NC}"
else
    echo -e "${YELLOW}Creating new secret...${NC}"

    aws secretsmanager create-secret \
        --name "$SECRET_NAME" \
        --description "Claude Code OAuth token for warmup Lambda" \
        --secret-string "$SECRET_JSON" \
        --region "$AWS_REGION"

    echo ""
    echo -e "${GREEN}✓ Secret created successfully${NC}"
fi

# Get secret ARN
SECRET_ARN=$(aws secretsmanager describe-secret \
    --secret-id "$SECRET_NAME" \
    --region "$AWS_REGION" \
    --query 'ARN' \
    --output text)

echo ""
echo -e "${BLUE}========================================"
echo "Secret Configuration Complete"
echo -e "========================================${NC}"
echo ""
echo "Secret Name: $SECRET_NAME"
echo "Secret ARN:  $SECRET_ARN"
echo "Region:      $AWS_REGION"
echo ""
echo -e "${BLUE}========================================"
echo "Next Steps"
echo -e "========================================${NC}"
echo ""
echo "1. Deploy the Lambda function:"
echo "   npm run deploy"
echo ""
echo "2. Subscribe to alerts (optional):"
echo "   aws sns subscribe \\"
echo "     --topic-arn <AlertTopicArn from deploy output> \\"
echo "     --protocol email \\"
echo "     --notification-endpoint your@email.com \\"
echo "     --region $AWS_REGION"
echo ""
echo "3. Verify the secret is accessible:"
echo "   aws secretsmanager get-secret-value \\"
echo "     --secret-id $SECRET_NAME \\"
echo "     --region $AWS_REGION"
echo ""
echo -e "${GREEN}Secret is now securely stored and ready for production use!${NC}"
echo ""
