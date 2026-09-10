# Amazon Connect Proficiency Manager

A React application embedded in the Amazon Connect Agent Workspace that lets agents view, add, update, and remove their own proficiency skills.

## Architecture

```text
Amazon Connect Agent Workspace
        |
        | loads the embedded application
        v
CloudFront + Amazon S3
        |
        | direct browser request
        v
Public Lambda Function URL
        |
        v
Lambda + Amazon Connect API
```

## How it works

1. The React application initialises inside the Amazon Connect Agent Workspace.
2. The Amazon Connect Agent Client returns the signed-in agent's ARN.
3. The frontend calls `GET /proficiencies` to load the agent's current skills.
4. The agent can:
   - **Change a proficiency level** using the dropdown — saved automatically on change, no button required
   - **Add a new skill** via the "Add skill" button — opens a modal to select attribute, value, and level
   - **Remove a skill** via the × button on any row — takes effect immediately
5. All write operations call Lambda which uses the Connect API to associate or disassociate proficiencies.

## Frontend configuration

Copy `.env.example` to `.env` and set:

```text
REACT_APP_API_BASE_URL=https://your-function-id.lambda-url.ap-southeast-2.on.aws/
```

The value must be the `FunctionUrl` output from the CloudFormation stack, including the trailing slash.

## Backend

The backend files are:

- `lambda/proficiency_manager.py` — Python 3.13 Lambda handler
- `infrastructure/template.yaml` — SAM CloudFormation stack

### Packaging the Lambda

```powershell
Compress-Archive -Path "lambda\proficiency_manager.py" -DestinationPath "lambda.zip" -Force
```

Upload `lambda.zip` to an S3 bucket as `proficiency-manager-function.zip` before deploying the stack.

### What the CloudFormation stack creates

- One Lambda function (Python 3.13, arm64, 128 MB, 10 s timeout)
- A public Lambda Function URL with `AuthType: NONE`
- CORS configured for GET, PUT, and DELETE methods
- IAM inline policy with the following permissions:

| Action | Resource |
|--------|----------|
| `connect:ListUserProficiencies` | `instance/<id>/agent/*` |
| `connect:AssociateUserProficiencies` | `*` |
| `connect:DisassociateUserProficiencies` | `*` |
| `connect:ListPredefinedAttributes` | `instance/<id>` |
| `connect:DescribePredefinedAttribute` | `instance/<id>` |

> `AssociateUserProficiencies` and `DisassociateUserProficiencies` require `Resource: "*"` — scoping them to a specific ARN results in `AccessDeniedException` from the Connect API.

### Restricting visible attributes

By default all predefined attributes in the Connect instance are shown in the Add Skill modal. To limit this to specific attributes, set the `ALLOWED_ATTRIBUTES` environment variable on the Lambda function to a comma-separated list of attribute names:

```
ALLOWED_ATTRIBUTES=DentalClinic_Skill
```

Multiple values: `ALLOWED_ATTRIBUTES=DentalClinic_Skill,AnotherSkill`

This can also be set via the `AllowedAttributes` parameter when deploying or updating the CloudFormation stack.

## API routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/attributes` | Returns all allowed predefined attributes and their values |
| `GET` | `/proficiencies?agentArn=<arn>` | Returns the agent's current proficiency list |
| `PUT` | `/proficiencies` | Adds or updates proficiencies for the agent |
| `DELETE` | `/proficiencies` | Removes specific proficiencies from the agent |

### PUT /proficiencies request body

```json
{
  "agentArn": "arn:aws:connect:ap-southeast-2:123456789012:instance/<id>/agent/<userId>",
  "proficiencies": [
    { "attributeName": "DentalClinic_Skill", "attributeValue": "Callback", "level": 3 }
  ]
}
```

### DELETE /proficiencies request body

```json
{
  "agentArn": "arn:aws:connect:ap-southeast-2:123456789012:instance/<id>/agent/<userId>",
  "proficiencies": [
    { "attributeName": "DentalClinic_Skill", "attributeValue": "Callback" }
  ]
}
```

Proficiency `level` must be an integer between **1** and **5** inclusive.

## Amazon Connect integration

The embedded application requires these workspace permissions in the agent's security profile:

```json
["User.Details.View", "User.Configuration.View"]
```

The application must be added under **Integrations → Applications** in the Connect console, and enabled in the relevant security profile.

## Full deployment guide

See `infrastructure/CLOUDFRONT.md` for the complete step-by-step deployment procedure covering S3, CloudFormation, CloudFront, and Connect integration.

## Testing

1. Open the Proficiency Manager panel inside the Amazon Connect Agent Workspace.
2. Confirm the agent's current skills appear in the table with their saved levels.
3. Change a proficiency level using the dropdown — the row shows **Saving…** then returns to **Saved** automatically.
4. Click **Add skill**, select an attribute, value, and level, then click **Add** — the new skill appears in the table.
5. Click the **×** button on a skill — it is removed from the table immediately.
