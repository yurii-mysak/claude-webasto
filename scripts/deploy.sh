#!/bin/bash
# deploy.sh: Build and deploy the Claude Webasto Lambda

set -e
cd "$(dirname "$0")/.." || exit 1

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}========================================"
echo "Claude Webasto - Deploy"
echo -e "========================================${NC}"
echo ""

# Check prerequisites
if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js not found${NC}"
    echo "Install from: https://nodejs.org/"
    exit 1
fi
echo -e "${GREEN}✓ Node.js $(node --version)${NC}"

if ! command -v npm &> /dev/null; then
    echo -e "${RED}Error: npm not found${NC}"
    exit 1
fi
echo -e "${GREEN}✓ npm $(npm --version)${NC}"

if ! command -v aws &> /dev/null; then
    echo -e "${RED}Error: AWS CLI not found${NC}"
    echo "Install from: https://aws.amazon.com/cli/"
    exit 1
fi
echo -e "${GREEN}✓ AWS CLI configured${NC}"

echo ""

# Install dependencies
echo -e "${YELLOW}Installing dependencies...${NC}"
npm install
echo ""

# Build TypeScript
echo -e "${YELLOW}Building TypeScript...${NC}"
npm run build
echo ""

# Deploy with Serverless
echo -e "${YELLOW}Deploying with Serverless Framework...${NC}"
npx serverless deploy --verbose
echo ""

echo -e "${GREEN}========================================"
echo "Deploy complete!"
echo -e "========================================${NC}"
echo ""
echo "To view deployment info:"
echo "  npx serverless info"
echo ""
echo "To view logs:"
echo "  npx serverless logs -f warmup --tail"
echo ""
echo "To invoke manually:"
echo "  npx serverless invoke -f warmup"
echo ""
