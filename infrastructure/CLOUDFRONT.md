# Deployment Guide

This guide walks through the full deployment of the Proficiency Manager with Okta authentication: a React frontend hosted on S3 behind CloudFront, and a Python Lambda backend with JWT validation.

**Architecture overview:**
```
Amazon Connect Agent Workspace
        │
        │ iframe embeds the app
        ▼
CloudFront (HTTPS + CSP headers)
        │
        ▼
S3 Bucket (private, OAC access only)
        │
React App ──► Lambda Function URL
                    │
                    ├── Okta JWT validation
                    │
                    ▼
              Amazon Connect API
```

---

## Security Features

This deployment includes multiple layers of security:

| Feature | Description |
|---------|-------------|
| **Okta JWT Authentication** | Every API request is validated against Okta public signing keys (JWKS) |
| **JWKS Caching** | Lambda caches Okta signing keys with 1-hour TTL to reduce latency |
| **Private S3 Bucket** | Frontend bucket blocks all public access — no direct S3 URLs work |
| **CloudFront Origin Access Control (OAC)** | S3 only accessible via CloudFront, not directly |
| **Content Security Policy (CSP)** | `frame-ancestors` header restricts embedding to Amazon Connect workspace only |
| **Restricted CORS** | Lambda Function URL only accepts requests from the CloudFront domain |
| **HTTPS Only** | CloudFront redirects HTTP to HTTPS; all traffic is encrypted |

---

## Prerequisites

- AWS CLI installed and authenticated (`aws sts get-caller-identity` should return your account)
- Node.js and npm installed
- Access to CloudFormation, S3, Lambda, IAM, and CloudFront in the same AWS region as your Connect instance
- **Okta administrator access** to create an OIDC application

---

## Step 0 — Configure Okta OIDC Application

Before deploying AWS resources, create an Okta application for authentication.

### 0.1 Create the Application

1. Log in to your **Okta Admin Console** (e.g., `https://your-org-admin.okta.com`)
2. Navigate to **Applications → Applications**
3. Click **Create App Integration**
4. Select:
   - **Sign-in method:** OIDC - OpenID Connect
   - **Application type:** Single-Page Application
5. Click **Next**

### 0.2 Configure the Application

| Field | Value |
|-------|-------|
| **App integration name** | `Proficiency Manager` |
| **Grant type** | ✅ Authorization Code (default) |
| | ✅ **Implicit (hybrid)** — expand "Advanced" to enable this |
| **Sign-in redirect URIs** | `https://placeholder.cloudfront.net` (update after Step 3) |
| **Sign-out redirect URIs** | `https://placeholder.cloudfront.net` (update after Step 3) |
| **Controlled access** | Choose based on your needs (e.g., "Allow everyone in your organization") |

> **Important:** You must enable **Implicit (hybrid)** grant type. The app uses implicit flow to obtain ID tokens without a backend token exchange.

### 0.3 Save and Note Credentials

After saving, copy these values — you'll need them for the CloudFormation deployment:

| Value | Where to Find It | Example |
|-------|------------------|---------|
| **Okta Issuer URL** | Your Okta domain (browser address bar, without `/admin/...`) | `https://your-org.okta.com` |
| **Client ID** | Application's General tab → Client Credentials section | `0oa1b2c3d4e5f6g7h8i9` |

### 0.4 Verify Token Settings

1. In your Okta app, go to the **Sign On** tab
2. Scroll to **OpenID Connect ID Token**
3. Ensure these scopes are allowed: `openid`, `profile`

---

## Step 1 — Package the Lambda

From the `Proficiency-Manager` project folder, create the deployment zip:

```powershell
Compress-Archive -Path "lambda\proficiency_manager.py" -DestinationPath "lambda.zip" -Force
```

---

## Step 2 — Create a deployment S3 bucket

1. Open **AWS S3** in the same region as your Connect instance
2. Click **Create bucket**
3. Give it a name (e.g., `proficiency-manager-deploy-YOUR-ACCOUNT-ID`) — this bucket holds the Lambda code only
4. Leave all other settings as default and create the bucket

Upload the Lambda zip:

```powershell
aws s3 cp "lambda.zip" s3://YOUR-DEPLOYMENT-BUCKET/lambda.zip
```

---

## Step 3 — Deploy the CloudFormation stack

The stack creates all resources automatically: Lambda, Function URL, S3 frontend bucket, CloudFront distribution, IAM policies, and security configurations.

### 3.1 Deploy via AWS Console

1. Open **AWS CloudFormation** → **Create stack → With new resources (standard)**
2. Choose **Upload a template file** → select `infrastructure/template.yaml` → **Next**
3. Fill in the parameters:

| Parameter | Value |
|-----------|-------|
| **Stack name** | `proficiency-manager` |
| **LambdaCodeBucket** | Name of the S3 bucket from Step 2 |
| **LambdaCodeKey** | `lambda.zip` |
| **ConnectInstanceId** | Your Connect instance UUID (e.g., `eefde7f8-7534-4dac-a433-f5a922235cc5`) |
| **ConnectInstanceArn** | Full ARN: `arn:aws:connect:<region>:<account-id>:instance/<ConnectInstanceId>` |
| **OktaIssuer** | Your Okta tenant URL from Step 0 (e.g., `https://your-org.okta.com`) |
| **OktaClientId** | The Client ID from Step 0 (e.g., `0oa1b2c3d4e5f6g7h8i9`) |
| **AllowedAttributes** | Leave blank to show all, or comma-separated list (e.g., `Skill1,Skill2`) |
| **FrontendBucketName** | Globally unique name (e.g., `proficiency-manager-frontend-YOUR-ACCOUNT-ID`) |

4. Click **Next** → **Next**
5. Check **"I acknowledge that AWS CloudFormation might create IAM resources"**
6. Click **Submit**
7. Wait for the stack status to reach **CREATE_COMPLETE** (5–10 minutes)

### 3.2 Note the Stack Outputs

Go to the **Outputs** tab and copy these values:

| Output | Example | Used For |
|--------|---------|----------|
| **CloudFrontUrl** | `https://d1234abcd.cloudfront.net` | Okta redirect URI, Connect app registration |
| **FunctionUrl** | `https://xxx.lambda-url.ap-southeast-2.on.aws/` | Frontend `.env` configuration |
| **FrontendBucketName** | `proficiency-manager-frontend-123456` | Uploading the React build |

---

## Step 4 — Update Okta Redirect URIs

Now that you have the CloudFront URL, update your Okta application:

1. Go to **Okta Admin Console → Applications → Proficiency Manager**
2. Click **Edit** in the General Settings section
3. Update both URIs to your CloudFront URL:
   - **Sign-in redirect URI:** `https://YOUR-CLOUDFRONT-DOMAIN`
   - **Sign-out redirect URI:** `https://YOUR-CLOUDFRONT-DOMAIN`
4. Click **Save**

> **Note:** The URI must match exactly — no trailing slash.

---

## Step 5 — Build the frontend

1. Copy `.env.example` to `.env`:

```powershell
Copy-Item .env.example .env
```

2. Edit `.env` with your values:

```env
REACT_APP_API_BASE_URL=https://xxx.lambda-url.ap-southeast-2.on.aws/
REACT_APP_OKTA_ISSUER=https://your-org.okta.com
REACT_APP_OKTA_CLIENT_ID=0oa1b2c3d4e5f6g7h8i9
```

> **Important:** The API URL should include the trailing slash.

3. Install dependencies and build:

```powershell
npm install
npm run build
```

---

## Step 6 — Upload the frontend to S3

```powershell
aws s3 sync "build" s3://YOUR-FRONTEND-BUCKET/ --delete
```

Then invalidate the CloudFront cache so the new files are served immediately:

```powershell
aws cloudfront create-invalidation --distribution-id YOUR-DISTRIBUTION-ID --paths "/*"
```

To find your distribution ID:
```powershell
aws cloudfront list-distributions --query "DistributionList.Items[?Origins.Items[0].DomainName=='YOUR-FRONTEND-BUCKET.s3.YOUR-REGION.amazonaws.com'].Id" --output text
```

Or create the invalidation manually in the CloudFront console: **Invalidations → Create invalidation → Object paths: `/*`**

---

## Step 7 — Register the app in Amazon Connect

### 7.1 Add the Application

1. Go to **Amazon Connect Console** → your instance → **Integrations** → **Applications**
2. Click **Add application**
3. Fill in:

| Field | Value |
|-------|-------|
| **Name** | `Proficiency Manager` |
| **Access URL** | `https://YOUR-CLOUDFRONT-DOMAIN` |
| **Namespace** | Leave default |
| **Permissions** | `User.Details.View`, `User.Configuration.View` |

4. Click **Save**

### 7.2 Enable for Security Profiles

1. Go to **Users** → **Security profiles**
2. Open the security profile assigned to your agents
3. Find the **Proficiency Manager** application and enable it
4. Click **Save**

---

## Step 8 — Test

1. Log in to the **Amazon Connect Agent Workspace** as a test agent
2. Open the **Proficiency Manager** panel
3. Verify the agent's current skills appear in the table
4. Click **Add skill** → select an attribute, a value, and a level → click **Add**
   - The new skill should appear immediately with status **Saved**
5. Change a proficiency level using the dropdown — the row shows **Saving…** while the API call is in flight, then returns to **Saved** automatically
6. Click the **× (remove)** button on a skill — it is removed immediately

---

## Verify Security Configuration

After deployment, verify the security features are working:

### Lambda JWT Validation

Check CloudWatch Logs for your Lambda function. Successful requests show:
```
INFO - Token verified for user: user@example.com
```

Failed authentication attempts show:
```
ERROR - Token validation failed: <reason>
```

### CloudFront CSP Header

Open browser DevTools on the CloudFront URL and check the response headers:
```
content-security-policy: frame-ancestors https://*.awsapps.com https://*.my.connect.aws
```

This prevents the app from being embedded in any site other than Amazon Connect.

### CORS Restriction

The Lambda Function URL only accepts requests from your CloudFront domain. Requests from other origins will be blocked with a CORS error.

### S3 Private Access

Direct S3 URLs like `https://bucket.s3.amazonaws.com/index.html` should return **403 Forbidden**. Only CloudFront can access the bucket.

---

## Updating after code changes

### Lambda changes

```powershell
# Rebuild the zip
Compress-Archive -Path "lambda\proficiency_manager.py" -DestinationPath "lambda.zip" -Force

# Upload to the deployment bucket
aws s3 cp "lambda.zip" s3://YOUR-DEPLOYMENT-BUCKET/lambda.zip

# Update the function code directly
aws lambda update-function-code --function-name proficiency-manager-handler --zip-file fileb://lambda.zip
```

### Frontend changes

```powershell
npm run build
aws s3 sync "build" s3://YOUR-FRONTEND-BUCKET/ --delete
aws cloudfront create-invalidation --distribution-id YOUR-DISTRIBUTION-ID --paths "/*"
```

### Okta configuration changes

If you need to change the Okta issuer or client ID:

1. Go to **CloudFormation** → your stack → **Update**
2. Choose **Use current template** → **Next**
3. Update `OktaIssuer` and/or `OktaClientId` parameters
4. Click **Next** → **Next** → **Submit**
5. Rebuild and redeploy the frontend with updated `.env` values

---

## Rollback

**Frontend:** Re-upload the previous `build` folder to S3 and run a CloudFront invalidation.

**Lambda:** Upload the previous `lambda.zip` and run `update-function-code` pointing to the old zip.

**Full teardown:**
```powershell
# Empty the frontend bucket first (required before stack deletion)
aws s3 rm s3://YOUR-FRONTEND-BUCKET --recursive

# Delete the stack
aws cloudformation delete-stack --stack-name proficiency-manager

# Optionally delete the deployment bucket
aws s3 rb s3://YOUR-DEPLOYMENT-BUCKET --force
```

> **Note:** Don't forget to also delete or deactivate the Okta application if no longer needed.

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| "Authentication failed" error | Okta token invalid, expired, or misconfigured | Verify `REACT_APP_OKTA_ISSUER` and `REACT_APP_OKTA_CLIENT_ID` in `.env` match the Okta app; check Okta app has Implicit grant enabled |
| "Authorization token is required" | Frontend not sending Bearer token | Verify all three `.env` variables are set; rebuild and redeploy frontend |
| CORS error in browser console | Request origin doesn't match CloudFront domain | Stack auto-configures this; ensure stack deployed successfully and you're accessing via CloudFront URL |
| 403 on CloudFront URL | S3 bucket policy or OAC issue | Stack creates these automatically; check `FrontendBucketPolicy` resource in CloudFormation |
| 403 on direct S3 URL | Expected behavior | S3 is private — access only via CloudFront |
| "Failed to fetch" on page load | Wrong API URL or CloudFront serving cached old version | Confirm `.env` URL matches the CloudFormation `FunctionUrl` output; rebuild, sync to S3, invalidate CloudFront |
| "Open this application from Amazon Connect" | App opened directly in browser | Access through the Connect Agent Workspace panel, not the CloudFront URL directly |
| Add skill modal shows no attributes | Lambda missing permissions or `AllowedAttributes` filter too restrictive | Check `ALLOWED_ATTRIBUTES` env var; verify IAM policy includes `ListPredefinedAttributes` |
| `AccessDeniedException` on proficiency updates | IAM policy has scoped resource ARN | `AssociateUserProficiencies` and `DisassociateUserProficiencies` require `"Resource": "*"` |
| Token validation fails in Lambda logs | Okta JWKS endpoint unreachable or clock skew | Check Lambda has internet access; verify server time is accurate |

---

## IAM Policy Reference

The CloudFormation stack creates this IAM policy for the Lambda function:

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": ["connect:ListUserProficiencies"],
            "Resource": ["arn:aws:connect:<region>:<account-id>:instance/<ConnectInstanceId>/agent/*"]
        },
        {
            "Effect": "Allow",
            "Action": [
                "connect:AssociateUserProficiencies",
                "connect:DisassociateUserProficiencies"
            ],
            "Resource": ["*"]
        },
        {
            "Effect": "Allow",
            "Action": [
                "connect:ListPredefinedAttributes",
                "connect:DescribePredefinedAttribute"
            ],
            "Resource": ["arn:aws:connect:<region>:<account-id>:instance/<ConnectInstanceId>"]
        }
    ]
}
```

> **Note:** `AssociateUserProficiencies` and `DisassociateUserProficiencies` require `"Resource": "*"` — scoping them to a specific resource ARN results in `AccessDeniedException` from the Connect API.
