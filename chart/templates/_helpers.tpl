{{/* vim: set filetype=mustache: */}}
{{/*
Helpers for the apple-pay-automation chart. Mirrors the helper set in the
google-pay-automation chart (itself mirroring storefronts / sd-subscription-app)
so anyone familiar with those can read this one without surprise.

The hash-versioning helpers (app.configVersion, app.secretVersion) are
load-bearing: they make the rendered ConfigMap and OnePasswordItem names depend
on a sha256 of their contents, so editing a value forces the Deployment to roll
a new ReplicaSet automatically.
*/}}

{{/*
Chart name. Defaults to .Chart.Name, overridable via .Values.nameOverride.
*/}}
{{- define "app.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Fully qualified name. If the release name already contains the chart name, the
release name is used unchanged; otherwise the release is prefixed with it.

The "RELEASE-NAME" condition supports helm's --generate-name, which would
otherwise produce names exceeding 63 chars.
*/}}
{{- define "app.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if eq .Release.Name "RELEASE-NAME" }}
{{- .Release.Name -}}
{{- else if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Chart label, formatted name-version.
*/}}
{{- define "app.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Standard Kubernetes recommended labels, applied to every object the chart emits.

`version` carries the git SHA so it appears alongside the chart's own version on
dashboards that hide tags.datadoghq.com/* labels.
*/}}
{{- define "app.labels" -}}
version: {{ .Values.deployment.sha | quote }}
helm.sh/chart: {{ include "app.chart" . }}
app.kubernetes.io/name: {{ include "app.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: {{ .Chart.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Values.deployment.sha | quote }}
{{- end -}}

{{/*
The DataDog tag labels every object repeats. Kept in one place so a change to
the tagging convention is a single edit.
*/}}
{{- define "app.datadogLabels" -}}
tags.datadoghq.com/env: {{ .Values.app.env | quote }}
tags.datadoghq.com/service: {{ include "app.fullname" . }}
tags.datadoghq.com/version: {{ .Values.deployment.sha | quote }}
{{- end -}}

{{/*
Hash of the ConfigMap values. Five chars of sha256 is enough collision
resistance for our cardinality. Mutating any value in .Values.app.config
produces a new hash, a new ConfigMap object name, and a new pod hash,
triggering a rolling update.
*/}}
{{- define "app.configVersion" -}}
{{ .Values.app.config | toYaml | sha256sum | trunc 5 }}
{{- end -}}

{{/*
Hash of the secret values. Same idea, for the OnePasswordItem CR. Rotating the
underlying 1Password item does NOT change this hash — the operator updates the
k8s Secret in place and its auto-restart annotation rolls the Deployment — but
changing the CR's spec (new vault, new item) does.
*/}}
{{- define "app.secretVersion" -}}
{{ .Values.app.secrets | toYaml | sha256sum | trunc 5 }}
{{- end -}}

{{/*
Image reference. Prefers .image.version if set (semver-style pins), falls back
to .image.tag (the git SHA in the normal deploy flow), then .Chart.AppVersion.
*/}}
{{- define "app.image" -}}
{{- $name := .Values.app.image.repository -}}
{{- if hasKey .Values.app.image "version" -}}
{{- printf "%s:%s" $name .Values.app.image.version -}}
{{- else if hasKey .Values.app.image "tag" -}}
{{- printf "%s:%s" $name .Values.app.image.tag -}}
{{- else -}}
{{- printf "%s:%s" $name .Chart.AppVersion -}}
{{- end -}}
{{- end -}}

{{/*
Name of the PVC holding the Apple portal session. Separate helper because both
the PVC and the Deployment's volume reference it.
*/}}
{{- define "app.sessionClaimName" -}}
{{ include "app.fullname" . }}-session
{{- end -}}
