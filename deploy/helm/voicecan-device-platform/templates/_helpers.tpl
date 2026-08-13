{{- define "voicecan.name" -}}voicecan-device-platform{{- end -}}
{{- define "voicecan.labels" -}}
app.kubernetes.io/name: {{ include "voicecan.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
{{- define "voicecan.image" -}}
{{- $digest := required "image.digest must pin an immutable sha256 digest" .Values.image.digest -}}
{{ .Values.image.repository }}@{{ $digest }}
{{- end -}}
