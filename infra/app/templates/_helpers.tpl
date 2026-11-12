{{/* Check the rendered PodSpec, including init containers and projected Secret volumes. */}}
{{- define "tin.checkLiveSecrets" -}}
{{- $root := .root -}}
{{- $secret := printf "%s-database-main" $root.Values.dpoc.service -}}
{{- if not (has $root.Values.database.reload (list "live" "restart")) -}}
{{- fail "database.reload must be live or restart" -}}
{{- end -}}
{{- if eq $root.Values.database.reload "live" -}}
{{- $pod := .object.spec.template.spec -}}
{{- $volumes := dict -}}
{{- range $v := $pod.volumes -}}
{{- if eq (dig "secret" "secretName" "" $v) $secret -}}{{- $_ := set $volumes $v.name true -}}{{- end -}}
{{- range $source := dig "projected" "sources" (list) $v -}}
{{- if eq (dig "secret" "name" "" $source) $secret -}}{{- $_ := set $volumes $v.name true -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- range $container := concat ($pod.containers | default list) ($pod.initContainers | default list) -}}
{{- range $e := $container.env -}}
{{- if eq (dig "valueFrom" "secretKeyRef" "name" "" $e) $secret -}}
{{- fail (printf "reload-live secret %q through env %s in %s: mount a whole folder" $secret $e.name $container.name) -}}
{{- end -}}
{{- end -}}
{{- range $e := $container.envFrom -}}
{{- if eq (dig "secretRef" "name" "" $e) $secret -}}
{{- fail (printf "reload-live secret %q through envFrom in %s: mount a whole folder" $secret $container.name) -}}
{{- end -}}
{{- end -}}
{{- range $m := $container.volumeMounts -}}
{{- if and (hasKey $volumes $m.name) (or $m.subPath $m.subPathExpr) -}}
{{- fail (printf "reload-live secret %q through subPath in %s: mount a whole folder" $secret $container.name) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

