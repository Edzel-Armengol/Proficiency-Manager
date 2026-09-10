import base64
import json
import logging
import os
import re
from typing import Any

import boto3
from botocore.exceptions import ClientError


LOGGER = logging.getLogger()
LOGGER.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

INSTANCE_ID = os.environ.get("CONNECT_INSTANCE_ID", "").strip()
INSTANCE_ARN = os.environ.get("CONNECT_INSTANCE_ARN", "").strip()

# Optional comma-separated allowlist of predefined attribute names.
# When set, only those attributes are returned by GET /attributes.
# When blank, all predefined attributes are returned.
_raw_allowed = os.environ.get("ALLOWED_ATTRIBUTES", "").strip()
ALLOWED_ATTRIBUTES: set[str] = {
    name.strip() for name in _raw_allowed.split(",") if name.strip()
}

UUID_PATTERN = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-"
    r"[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
)
# Proficiency level must be an integer between 1 and 5 inclusive (Connect API constraint)
PROFICIENCY_LEVEL_MIN = 1
PROFICIENCY_LEVEL_MAX = 5
MAX_REQUEST_BODY_BYTES = 4096

connect = boto3.client("connect")


class RequestError(Exception):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    request_id = getattr(context, "aws_request_id", "unknown")

    try:
        if not INSTANCE_ID:
            raise RuntimeError("CONNECT_INSTANCE_ID is required")
        if not INSTANCE_ARN:
            raise RuntimeError("CONNECT_INSTANCE_ARN is required")

        method = event.get("requestContext", {}).get("http", {}).get("method", "")
        path = (event.get("rawPath") or "/").rstrip("/") or "/"

        # GET /attributes — list all predefined attribute names and values
        if method == "GET" and path.endswith("/attributes"):
            attributes = list_predefined_attributes()
            LOGGER.info(json.dumps({
                "event": "attributes_listed",
                "requestId": request_id,
                "resultCount": len(attributes),
            }))
            return response(200, {"attributes": attributes})

        # GET /proficiencies?agentArn=<arn>
        if method == "GET" and path.endswith("/proficiencies"):
            agent_arn = (event.get("queryStringParameters") or {}).get("agentArn", "")
            connect_user_id = connect_user_id_from_arn(agent_arn)
            proficiencies = list_user_proficiencies(connect_user_id)
            LOGGER.info(json.dumps({
                "event": "proficiencies_listed",
                "requestId": request_id,
                "connectUserId": connect_user_id,
                "resultCount": len(proficiencies),
            }))
            return response(200, {"proficiencies": proficiencies})

        # PUT /proficiencies  — full replace of agent proficiencies
        if method == "PUT" and path.endswith("/proficiencies"):
            body = parse_json_body(event)

            required_keys = {"agentArn", "proficiencies"}
            if set(body.keys()) != required_keys:
                raise RequestError(
                    400,
                    "agentArn and proficiencies are required.",
                )

            result = update_user_proficiencies(
                agent_arn=body["agentArn"],
                proficiencies=body["proficiencies"],
                request_id=request_id,
            )
            return response(200, result)

        # DELETE /proficiencies — remove specific proficiencies from an agent
        if method == "DELETE" and path.endswith("/proficiencies"):
            body = parse_json_body(event)

            required_keys = {"agentArn", "proficiencies"}
            if set(body.keys()) != required_keys:
                raise RequestError(
                    400,
                    "agentArn and proficiencies are required.",
                )

            result = delete_user_proficiencies(
                agent_arn=body["agentArn"],
                proficiencies=body["proficiencies"],
                request_id=request_id,
            )
            return response(200, result)

        raise RequestError(404, "Route not found.")

    except RequestError as error:
        LOGGER.warning(json.dumps({
            "event": "request_rejected",
            "requestId": request_id,
            "statusCode": error.status_code,
            "reason": error.message,
        }))
        return response(error.status_code, {"error": error.message})
    except ClientError as error:
        error_code = error.response.get("Error", {}).get("Code", "Unknown")
        error_msg = error.response.get("Error", {}).get("Message", "")
        operation = error.operation_name if hasattr(error, "operation_name") else "Unknown"
        LOGGER.error(json.dumps({
            "event": "connect_api_error",
            "requestId": request_id,
            "errorCode": error_code,
            "errorMessage": error_msg,
            "operation": operation,
        }))
        if error_code in {
            "ResourceNotFoundException",
            "InvalidParameterException",
            "InvalidRequestException",
        }:
            return response(400, {"error": "The proficiency change is invalid."})
        return response(500, {"error": "The proficiency service is unavailable."})
    except Exception:
        LOGGER.exception(json.dumps({
            "event": "unhandled_error",
            "requestId": request_id,
        }))
        return response(500, {"error": "The proficiency service is unavailable."})


# ---------------------------------------------------------------------------
# Request helpers
# ---------------------------------------------------------------------------

def parse_json_body(event: dict[str, Any]) -> dict[str, Any]:
    raw_body = event.get("body") or ""
    if not isinstance(raw_body, str):
        raise RequestError(400, "Request body must be valid JSON.")

    try:
        body_bytes = (
            base64.b64decode(raw_body, validate=True)
            if event.get("isBase64Encoded")
            else raw_body.encode("utf-8")
        )
    except (ValueError, UnicodeError) as error:
        raise RequestError(400, "Request body must be valid JSON.") from error

    if len(body_bytes) > MAX_REQUEST_BODY_BYTES:
        raise RequestError(413, "Request body is too large.")

    try:
        body = json.loads(body_bytes.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeError) as error:
        raise RequestError(400, "Request body must be valid JSON.") from error

    if not isinstance(body, dict):
        raise RequestError(400, "Request body must be a JSON object.")
    return body


def connect_user_id_from_arn(agent_arn: Any) -> str:
    """Extract and validate the Connect user ID from an agent ARN."""
    if not isinstance(agent_arn, str) or not agent_arn:
        raise RequestError(400, "agentArn must be provided.")

    marker = f":instance/{INSTANCE_ID}/agent/"
    if marker not in agent_arn:
        raise RequestError(400, "agentArn does not belong to this Connect instance.")

    connect_user_id = agent_arn.rsplit("/", 1)[-1]
    if not UUID_PATTERN.fullmatch(connect_user_id):
        raise RequestError(400, "agentArn is invalid.")
    return connect_user_id


# ---------------------------------------------------------------------------
# Connect API wrappers
# ---------------------------------------------------------------------------

def list_predefined_attributes() -> list[dict[str, Any]]:
    """Return predefined attributes (skills) defined in the Connect instance.

    If ALLOWED_ATTRIBUTES is set, only those attribute names are returned.
    Otherwise all predefined attributes are returned.
    """
    attributes = []
    paginator = connect.get_paginator("list_predefined_attributes")

    for page in paginator.paginate(InstanceId=INSTANCE_ID):
        for item in page.get("PredefinedAttributeSummaryList", []):
            name = item.get("Name", "")
            if not name:
                continue
            # Apply allowlist filter if configured
            if ALLOWED_ATTRIBUTES and name not in ALLOWED_ATTRIBUTES:
                continue
            attributes.append({"name": name})

    # Fetch values for each attribute
    result = []
    for attr in attributes:
        try:
            detail = connect.describe_predefined_attribute(
                InstanceId=INSTANCE_ID,
                Name=attr["name"],
            )
            pa = detail.get("PredefinedAttribute", {})
            values_obj = pa.get("Values", {})
            # StringList is the only supported type for proficiency values
            string_list = values_obj.get("StringList", [])
            result.append({
                "name": attr["name"],
                "values": sorted(string_list),
            })
        except ClientError:
            # Skip attributes we can't describe
            pass

    result.sort(key=lambda a: a["name"].casefold())
    return result


def list_user_proficiencies(connect_user_id: str) -> list[dict[str, Any]]:
    """Return all proficiencies currently assigned to the agent."""
    proficiencies = []
    paginator = connect.get_paginator("list_user_proficiencies")

    for page in paginator.paginate(
        InstanceId=INSTANCE_ID,
        UserId=connect_user_id,
    ):
        for item in page.get("UserProficiencyList", []):
            proficiencies.append({
                "attributeName": item["AttributeName"],
                "attributeValue": item["AttributeValue"],
                "level": item["Level"],
            })

    # Sort for a stable, readable order
    proficiencies.sort(key=lambda p: (
        p["attributeName"].casefold(),
        p["attributeValue"].casefold(),
    ))
    return proficiencies


def validate_proficiencies(proficiencies: Any) -> list[dict[str, Any]]:
    """Validate the proficiency list sent by the frontend."""
    if not isinstance(proficiencies, list):
        raise RequestError(400, "proficiencies must be a list.")

    if len(proficiencies) == 0:
        raise RequestError(400, "proficiencies must contain at least one entry.")

    validated = []
    for idx, item in enumerate(proficiencies):
        if not isinstance(item, dict):
            raise RequestError(400, f"proficiencies[{idx}] must be an object.")

        attr_name = item.get("attributeName")
        attr_value = item.get("attributeValue")
        level = item.get("level")

        if not isinstance(attr_name, str) or not attr_name.strip():
            raise RequestError(400, f"proficiencies[{idx}].attributeName is required.")
        if not isinstance(attr_value, str) or not attr_value.strip():
            raise RequestError(400, f"proficiencies[{idx}].attributeValue is required.")
        if not isinstance(level, (int, float)) or not (
            PROFICIENCY_LEVEL_MIN <= int(level) <= PROFICIENCY_LEVEL_MAX
        ):
            raise RequestError(
                400,
                f"proficiencies[{idx}].level must be between "
                f"{PROFICIENCY_LEVEL_MIN} and {PROFICIENCY_LEVEL_MAX}.",
            )

        validated.append({
            "AttributeName": attr_name.strip(),
            "AttributeValue": attr_value.strip(),
            "Level": int(level),
        })

    return validated


def update_user_proficiencies(
    agent_arn: Any,
    proficiencies: Any,
    request_id: str,
) -> dict[str, Any]:
    """Replace the agent's proficiencies with the supplied list."""
    connect_user_id = connect_user_id_from_arn(agent_arn)
    validated = validate_proficiencies(proficiencies)

    # Step 1 — remove all existing proficiencies for the attributes being updated
    existing = list_user_proficiencies(connect_user_id)

    # Build the set of attribute names being updated so we only disassociate those
    updating_attr_names = {p["AttributeName"] for p in validated}
    to_disassociate = [
        {
            "AttributeName": p["attributeName"],
            "AttributeValue": p["attributeValue"],
        }
        for p in existing
        if p["attributeName"] in updating_attr_names
    ]

    if to_disassociate:
        connect.disassociate_user_proficiencies(
            InstanceId=INSTANCE_ID,
            UserId=connect_user_id,
            UserProficiencies=to_disassociate,
        )

    # Step 2 — associate the new proficiencies
    connect.associate_user_proficiencies(
        InstanceId=INSTANCE_ID,
        UserId=connect_user_id,
        UserProficiencies=validated,
    )

    LOGGER.info(json.dumps({
        "event": "proficiencies_updated",
        "requestId": request_id,
        "connectUserId": connect_user_id,
        "updatedCount": len(validated),
    }))

    # Return the refreshed proficiency list
    updated = list_user_proficiencies(connect_user_id)
    return {
        "success": True,
        "proficiencies": updated,
    }


def delete_user_proficiencies(
    agent_arn: Any,
    proficiencies: Any,
    request_id: str,
) -> dict[str, Any]:
    """Remove specific proficiencies from the agent."""
    connect_user_id = connect_user_id_from_arn(agent_arn)

    if not isinstance(proficiencies, list) or len(proficiencies) == 0:
        raise RequestError(400, "proficiencies must be a non-empty list.")

    to_disassociate = []
    for idx, item in enumerate(proficiencies):
        if not isinstance(item, dict):
            raise RequestError(400, f"proficiencies[{idx}] must be an object.")
        attr_name = item.get("attributeName")
        attr_value = item.get("attributeValue")
        if not isinstance(attr_name, str) or not attr_name.strip():
            raise RequestError(400, f"proficiencies[{idx}].attributeName is required.")
        if not isinstance(attr_value, str) or not attr_value.strip():
            raise RequestError(400, f"proficiencies[{idx}].attributeValue is required.")
        to_disassociate.append({
            "AttributeName": attr_name.strip(),
            "AttributeValue": attr_value.strip(),
        })

    connect.disassociate_user_proficiencies(
        InstanceId=INSTANCE_ID,
        UserId=connect_user_id,
        UserProficiencies=to_disassociate,
    )

    LOGGER.info(json.dumps({
        "event": "proficiencies_deleted",
        "requestId": request_id,
        "connectUserId": connect_user_id,
        "deletedCount": len(to_disassociate),
    }))

    updated = list_user_proficiencies(connect_user_id)
    return {
        "success": True,
        "proficiencies": updated,
    }


# ---------------------------------------------------------------------------
# Response helper
# ---------------------------------------------------------------------------

def response(status_code: int, body: dict[str, Any]) -> dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
        },
        "body": json.dumps(body),
    }
