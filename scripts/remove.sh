#!/bin/bash
# remove.sh: Remove the Claude Webasto stack from AWS

set -e
cd "$(dirname "$0")/.." || exit 1

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}========================================"
echo "Claude Webasto - Remove"
echo -e "========================================${NC}"
echo ""

echo -e "${RED}WARNING: This will remove the entire Claude Webasto stack from AWS.${NC}"
echo "This includes the Lambda function, CloudWatch alarms, and SNS topic."
echo ""

read -p "Are you sure you want to proceed? (y/N): " CONFIRM

if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
    echo ""
    echo "Aborted."
    exit 0
fi

echo ""
echo -e "${YELLOW}Removing Serverless stack...${NC}"
npx serverless remove --verbose
echo ""
echo -e "${GREEN}✓ Stack removed successfully${NC}"
echo ""

# Ask about Secrets Manager secret
read -p "Also delete the Secrets Manager secret (claude-webasto/prod/token)? (y/N): " DELETE_SECRET

if [ "$DELETE_SECRET" = "y" ] || [ "$DELETE_SECRET" = "Y" ]; then
    AWS_REGION=${AWS_REGION:-eu-north-1}
    echo ""
    echo -e "${YELLOW}Deleting secret...${NC}"
    aws secretsmanager delete-secret \
        --secret-id "claude-webasto/prod/token" \
        --force-delete-without-recovery \
        --region "$AWS_REGION"
    echo -e "${GREEN}✓ Secret deleted${NC}"
else
    echo ""
    echo -e "${YELLOW}Secret retained. To delete manually later:${NC}"
    echo "  aws secretsmanager delete-secret \\"
    echo "    --secret-id claude-webasto/prod/token \\"
    echo "    --force-delete-without-recovery \\"
    echo "    --region eu-north-1"
fi

echo ""
echo -e "${GREEN}Removal complete.${NC}"
echo ""
