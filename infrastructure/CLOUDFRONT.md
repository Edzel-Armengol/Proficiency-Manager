# Deployment Guide

This guide walks through the full deployment of the Proficiency Manager: a React frontend hosted on S3 behind CloudFront, and a Python Lambda backend exposed via a Lambda Function URL.

**Architecture overview:**
- React frontend → S3 bucket → CloudFront distribution
- Lambda Function URL → Amazon Connect API

---

## Prerequisites

- AWS CLI installed and authenticated (`aws sts get-caller-identity` should return your account)
- Node.js and npm installed
- Access to CloudFormation, S3, Lambda, IAM, and CloudFront in the same AWS region as your Connect instance

---

## Step 1 — Package the Lambda

From the `proficiency-manager` project folder, create the deployment zip:

```powershell
Compress-Archive -Path "lambda\proficiency_manager.py" -DestinationPath "lambda.zip" -Force
```

---

## Step 2 — Create a deployment S3 bucket

1. Open **AWS S3** in the same region as your Connect instance
2. Click **Create bucket**
3. Give it a name (e.g. `proficiency-manager-deploy`) — this bucket holds the Lambda code only
4. Leave all other settings as default and create the bucket

Upload the Lambda zip to it, either through the Console or through code:

```powershell
aws s3 cp "lambda.zip" s3://YOUR-DEPLOYMENT-BUCKET/proficiency-manager-function.zip
```

---

## Step 3 — Deploy the CloudFormation stack

1. Open **AWS CloudFormation** → **Create stack → With new resources (standard)**
2. Choose **Upload a template file** → select `infrastructure/template.yaml` → **Next**
3. Fill in the parameters:

| Parameter | Value |
|---|---|
| Stack name | `proficiency-changer` (or any name you prefer) |
| `LambdaCodeBucket` | Name of the S3 bucket from Step 2 |
| `LambdaCodeKey` | `proficiency-manager-function.zip` |
| `ConnectInstanceId` | Your Connect instance ID (e.g. `eefde7f8-7534-4dac-a433-f5a922235cc5`) |
| `ConnectInstanceArn` | Full ARN: `arn:aws:connect:<region>:<account-id>:instance/<ConnectInstanceId>` |
| `FrontendOrigin` | `*` for now — you will tighten this after CloudFront is created |

4. Click **Next** → **Next**
5. Check **"I acknowledge that AWS CloudFormation might create IAM resources"**
6. Click **Submit**
7. Wait for the stack status to reach **CREATE_COMPLETE**
8. Go to the **Outputs** tab and copy the **`FunctionUrl`** value — it looks like.:
   `https://xxxxxxxxxxxxxxxx.lambda-url.ap-southeast-2.on.aws/`

---

## Step 4 — Verify the Lambda IAM policy

After the stack is created, confirm the Lambda execution role has the correct permissions. The stack creates an inline policy automatically, but verify it matches this:

1. Go to **AWS Lambda** → your function → **Configuration** → **Permissions**
2. Click the execution role name to open it in IAM
3. Expand the inline policy — it should contain these three statements:

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Action": ["connect:ListUserProficiencies"],
            "Resource": ["arn:aws:connect:<region>:<account-id>:instance/<ConnectInstanceId>/agent/*"],
            "Effect": "Allow"
        },
        {
            "Action": [
                "connect:AssociateUserProficiencies",
                "connect:DisassociateUserProficiencies"
            ],
            "Resource": ["*"],
            "Effect": "Allow"
        },
        {
            "Action": [
                "connect:ListPredefinedAttributes",
                "connect:DescribePredefinedAttribute"
            ],
            "Resource": ["arn:aws:connect:<region>:<account-id>:instance/<ConnectInstanceId>"],
            "Effect": "Allow"
        }
    ]
}
```

> **Note:** `AssociateUserProficiencies` and `DisassociateUserProficiencies` require `"Resource": "*"` — scoping them to a specific resource ARN results in `AccessDeniedException` from the Connect API.

If the policy does not match, click **Edit** on the inline policy and update it manually.

---

## Step 5 — Build the frontend

1. In the project root, open `.env` and set the API URL to the `FunctionUrl` from Step 3:

```
REACT_APP_API_BASE_URL=https://xxxxxxxxxxxxxxxx.lambda-url.ap-southeast-2.on.aws/
```

Make sure the URL ends with a trailing slash `/`.

2. Install dependencies and build:

```powershell
npm install
npm run build
```

---

## Step 6 — Create the frontend S3 bucket

1. Open **AWS S3** → **Create bucket**
2. Name it (e.g. `proficiency-manager-frontend`) — this is separate from the deployment bucket
3. **Block all public access** — leave the default (all blocked). CloudFront will handle access privately via Origin Access Control (OAC)
4. Same region as Connect
5. Create the bucket — do not upload files yet

---

## Step 7 — Create the CloudFront distribution

1. Open **AWS CloudFront** → **Create distribution**

### Origin

| Field | Value |
|---|---|
| Origin type | **Amazon S3** |
| S3 origin | Click **Browse S3** and select your frontend bucket from Step 6 |
| Origin path | Leave empty |
| Allow private S3 bucket access | **Enable — Allow private S3 bucket access to CloudFront (Recommended)** |
| Origin settings | Use recommended origin settings |
| Cache settings | Use recommended cache settings tailored to serving S3 content |

Click **Next**.

### Default cache behavior

| Field | Value |
|---|---|
| Viewer protocol policy | **Redirect HTTP to HTTPS** |
| Allowed HTTP methods | GET, HEAD |
| Cache policy | CachingOptimized (default) |

Click **Next** through the remaining sections.

### Settings

| Field | Value |
|---|---|
| Default root object | **`index.html`** |

2. Click **Create distribution**
3. Wait for the status to change from **Deploying** to active (5–10 minutes)
4. Copy the **Distribution domain name** — e.g. `d10ivwxc3dvoty.cloudfront.net`

---

## Step 8 — Configure custom error pages

This is required so React Router works correctly. Without it, navigating directly to any route other than `/` returns a 403 error from S3.

1. Open your CloudFront distribution → **Error pages** tab
2. Click **Create custom error response** and add these two entries:

**First entry:**
| Field | Value |
|---|---|
| HTTP error code | `403` |
| Customize error response | Yes |
| Response page path | `/index.html` |
| HTTP response code | `200` |

**Second entry:**
| Field | Value |
|---|---|
| HTTP error code | `404` |
| Customize error response | Yes |
| Response page path | `/index.html` |
| HTTP response code | `200` |

---

## Step 9 — Upload the frontend to S3

```powershell
aws s3 sync "build" s3://YOUR-FRONTEND-BUCKET/ --delete
```

Then run a CloudFront invalidation so the new files are served immediately:

```powershell
aws cloudfront create-invalidation --distribution-id YOUR-DISTRIBUTION-ID --paths "/*"
```

Or just manually create the invalidation inside the cloudfront and just type "/*"

---

## Step 10 — Lock CORS to your CloudFront domain

Now that you have the CloudFront domain, update the stack to restrict API access to that origin only.

1. Go to **CloudFormation** → your stack → **Update**
2. Choose **Use current template** → **Next**
3. Change `FrontendOrigin` from `*` to your CloudFront domain exactly as shown:
   `https://d10ivwxc3dvoty.cloudfront.net`
   (no trailing slash — Lambda CORS will reject it otherwise)
4. Click **Next** → **Next** → **Submit**
5. Wait for **UPDATE_COMPLETE**

---

## Step 11 — Register the app in Amazon Connect

1. Go to **Amazon Connect Console** → your instance → **Integrations** → **Applications**
2. Click **Add application**
3. Fill in:

| Field | Value |
|---|---|
| Name | `Proficiency Manager` |
| Access URL | `https://YOUR-CLOUDFRONT-DOMAIN` |
| Namespace | Leave default |
| Permissions | `User.Details.View`, `User.Configuration.View` |

4. Save the application

5. Go to **Users** → **Security profiles** → open the security profile assigned to your agents
6. Find the **Proficiency Manager** application and enable it
7. Save the security profile

---

## Step 12 — Test

1. Log in to the **Amazon Connect Agent Workspace** as a test agent
2. Open the **Proficiency Manager** panel
3. Verify the agent's current skills appear in the table
4. Click **Add skill** → select an attribute, a value, and a level → click **Add**
   - The new skill should appear immediately with status **Saved**
5. Change a proficiency level using the dropdown — the row shows **Saving…** while the API call is in flight, then returns to **Saved** automatically
6. Click the **× (remove)** button on a skill — it is removed immediately

---

## Updating after code changes

### Lambda changes

```powershell
# Rebuild the zip
Compress-Archive -Path "lambda\proficiency_manager.py" -DestinationPath "lambda.zip" -Force

# Upload to the deployment bucket
aws s3 cp "lambda.zip" s3://YOUR-DEPLOYMENT-BUCKET/proficiency-manager-function.zip

# Update the function code directly
aws lambda update-function-code --function-name proficiency-changer-handler --zip-file fileb://lambda.zip
```

### Frontend changes

```powershell
npm run build
aws s3 sync "build" s3://YOUR-FRONTEND-BUCKET/ --delete
aws cloudfront create-invalidation --distribution-id YOUR-DISTRIBUTION-ID --paths "/*"
```

---

## Rollback

**Frontend:** Re-upload the previous `build` folder to S3 and run a CloudFront invalidation.

**Lambda:** Upload the previous `lambda.zip` and run `update-function-code` pointing to the old zip.

**Full teardown:** Delete the CloudFormation stack to remove the Lambda and its IAM role. The S3 buckets and CloudFront distribution are not managed by the stack and must be deleted manually if needed.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "Failed to fetch" on page load | Wrong API URL baked into the build, or CloudFront serving a cached old version | Confirm `.env` URL matches the CloudFormation `FunctionUrl` output, rebuild, sync to S3, invalidate CloudFront |
| 403 on the Lambda Function URL | Auth type is not NONE on the Function URL | Lambda → Configuration → Function URL → confirm Auth type is **NONE** |
| `AccessDeniedException` on `AssociateUserProficiencies` | IAM policy has a scoped resource ARN for that action | Edit the inline policy on the Lambda role — `AssociateUserProficiencies` and `DisassociateUserProficiencies` must use `"Resource": "*"` || Add skill modal shows no attributes | Lambda missing `ListPredefinedAttributes` / `DescribePredefinedAttribute` permissions | Check the inline policy includes those actions with the Connect instance ARN as the resource |
| Navigating to a route directly returns 403 | CloudFront missing custom error page configuration | Add 403 and 404 custom error responses pointing to `/index.html` with HTTP 200 (Step 8) |
| App shows "Open this application from Amazon Connect" | App opened directly in a browser instead of inside Agent Workspace | Access the app through the Connect Agent Workspace panel, not the CloudFront URL directly |
