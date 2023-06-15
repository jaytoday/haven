import transformers
from transformers import TextIteratorStreamer, StoppingCriteriaList
from threading import Thread
import torch

from models.base_causal import AutoCausalModel
from .inference_utils.stopping_criteria import StopOnTokens

class MPTModel(AutoCausalModel):
        
    def __init__(self, config):
        super().__init__(config)


    ##############################
    ### INFERENCE    #############
    ##############################
    def prepare_for_inference(self, int8_quantization: bool):
        if int8_quantization:
            raise NotImplementedError("MPT Models do not yet support 8bit-quantization. We're working on it!")
        
        hf_model_config = transformers.AutoConfig.from_pretrained(self.model_config["model_name"], trust_remote_code=True, low_cpu_mem_usage=True, torch_dtype=torch.bfloat16)
        hf_model_config.update({"max_seq_len": 28000})
        self.model = transformers.AutoModelForCausalLM.from_pretrained(self.model_config["model_name"], trust_remote_code=True, low_cpu_mem_usage=True, torch_dtype=torch.bfloat16, config=hf_model_config).to('cuda')
        self.tokenizer = transformers.AutoTokenizer.from_pretrained(self.model_config["model_name"])
        self.stopping_criteria = StoppingCriteriaList([StopOnTokens(self.tokenizer, self.model_config["stop_tokens"]+[self.tokenizer.eos_token])])


    def generate_stream(self, text_input: str, sample: bool = True, top_p: float = 0.8, top_k: int = 500, temperature: float = 0.9, max_length: int = 2048):
        return super().generate_stream(text_input, sample, top_p, top_k, temperature, max_length)