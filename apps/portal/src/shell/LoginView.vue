<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{
  /** 会话过期 / 未登录提示（如「会话已过期，请重新登录」）。 */
  message?: string
  error?: string
  signIn: (name: string) => Promise<void>
}>()

const name = ref('')
const loading = ref(false)
const failure = ref<string | undefined>()

async function submit(): Promise<void> {
  if (loading.value) return
  loading.value = true
  failure.value = undefined
  try {
    await props.signIn(name.value)
  } catch (error) {
    failure.value = String((error as Error)?.message ?? error)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-shell">
    <form class="twin-panel-card login-card" @submit.prevent="submit">
      <div class="login-brand">
        <div class="login-title">船舶制造数字孪生平台</div>
        <div class="login-sub">Architecture Freeze v1.2</div>
      </div>

      <div v-if="props.message" class="login-note">{{ props.message }}</div>
      <div v-if="props.error" class="login-note warn">{{ props.error }}</div>
      <div v-if="failure" class="login-note warn">{{ failure }}</div>

      <label class="login-field">
        <span>用户名</span>
        <input
          v-model="name"
          class="login-input"
          name="username"
          autocomplete="username"
          placeholder="输入任意名称（guest 开头为受限角色）"
        />
      </label>

      <button class="twin-btn login-submit" type="submit" :disabled="loading">
        {{ loading ? '登录中…' : '登录' }}
      </button>

      <div class="login-hint">
        演示身份：任意名称即可登录；以 guest 开头的名称为受限角色（用于验证权限拒绝路径）。
      </div>
    </form>
  </div>
</template>

<style scoped>
.login-shell {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--twin-bg);
}

.login-card {
  width: 360px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.login-title {
  font-weight: 700;
  font-size: 16px;
  color: #d7e6ff;
}

.login-sub {
  font-size: 11px;
  color: #7e97b8;
  letter-spacing: 0.06em;
}

.login-note {
  font-size: 12px;
  color: #8fc1ff;
  border: 1px solid var(--twin-border);
  border-radius: 6px;
  padding: 6px 8px;
}

.login-note.warn {
  color: #ffd166;
  border-color: rgba(255, 209, 102, 0.4);
}

.login-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #9db8d8;
}

.login-input {
  background: rgba(10, 18, 32, 0.9);
  border: 1px solid var(--twin-border);
  border-radius: 6px;
  color: var(--twin-text);
  padding: 8px 10px;
  font-size: 13px;
  outline: none;
}

.login-input:focus {
  border-color: var(--twin-accent);
}

.login-submit {
  padding: 8px 0;
  font-size: 13px;
}

.login-submit:disabled {
  opacity: 0.6;
  cursor: wait;
}

.login-hint {
  font-size: 11px;
  color: #7e97b8;
  line-height: 1.6;
}
</style>
