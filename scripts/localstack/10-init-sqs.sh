#!/usr/bin/env bash
set -euo pipefail
rm -f /tmp/wagering-sqs-ready

# boto3 é fornecido pela imagem oficial; reexecutar converge atributos sem apagar filas.
python3 - <<'PY'
import json
import os
import boto3

sqs = boto3.client(
    "sqs", endpoint_url="http://localhost:4566",
    region_name=os.environ.get("AWS_DEFAULT_REGION", "us-east-1"),
    aws_access_key_id="test", aws_secret_access_key="test",
)

def ensure_queue(name):
    result = sqs.create_queue(QueueName=name, Attributes={"FifoQueue": "true"})
    return result["QueueUrl"]

dlq_url = ensure_queue("wager-transactions-dlq.fifo")
dlq_arn = sqs.get_queue_attributes(QueueUrl=dlq_url, AttributeNames=["QueueArn"])["Attributes"]["QueueArn"]
command_url = ensure_queue("wager-transactions.fifo")
ensure_queue("wager-events.fifo")
sqs.set_queue_attributes(QueueUrl=command_url, Attributes={
    "VisibilityTimeout": "30",
    "RedrivePolicy": json.dumps({"deadLetterTargetArn": dlq_arn, "maxReceiveCount": 5}),
})
print("SQS inicializado: três filas FIFO e redrive maxReceiveCount=5.")
PY
touch /tmp/wagering-sqs-ready
