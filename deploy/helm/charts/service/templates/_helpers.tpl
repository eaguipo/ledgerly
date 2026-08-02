{{/*
Resource name for this service instance. Prefers fullnameOverride, then
nameOverride, then the chart/alias name (e.g. "web").
*/}}
{{- define "service.fullname" -}}
{{- .Values.fullnameOverride | default .Values.nameOverride | default .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Common labels applied to every object. */}}
{{- define "service.labels" -}}
app.kubernetes.io/name: {{ include "service.fullname" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: ledgerly
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{/* Selector labels (stable subset — never change these across releases). */}}
{{- define "service.selectorLabels" -}}
app.kubernetes.io/name: {{ include "service.fullname" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
