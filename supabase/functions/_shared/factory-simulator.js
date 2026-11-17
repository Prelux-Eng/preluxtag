/*
 * Nome compatível com os chamadores antigos. As regras agora pertencem ao
 * domínio Projeto, que não conhece Supabase, HTTP nem a interface.
 */
export {
  FACTORY_RULES,
  simulateProject as simulateFactory,
  simulateProject,
} from "./project-domain.js";
